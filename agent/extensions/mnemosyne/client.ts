import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * mnemosyne — client for a hosted Mnemosyne MCP server over
 * streamable HTTP.
 *
 * The server runs `mnemosyne mcp --transport streamable-http` behind nginx;
 * this client is a stateless-per-session JSON-RPC caller with lazy
 * initialize, session-id retention, and one re-init retry on session expiry.
 * "url" is optional and defaults to the hosted endpoint (MNEMOSYNE_URL or
 * DEFAULT_URL); "token" is the required credential (MEMORY_MCP_TOKEN).
 *
 * Tool contract (from mnemosyne/mcp_tools.py, all results are JSON text):
 * - mnemosyne_remember {content, importance, source, scope, bank} →
 *     {status:"stored", memory_id, content_preview, bank}
 * - mnemosyne_recall {query, limit, bank} →
 *     {status:"ok", count, results:[{id, content, source, timestamp, tier,
 *      score, ...}]}
 * - mnemosyne_get {memory_id, bank} → {status:"ok", memory:{...}} | not_found
 * - mnemosyne_forget {memory_id, bank} → {status:"deleted"|"not_found"}
 * - mnemosyne_stats {bank} → {provider, session_id, stats}
 * - mnemosyne_sleep {bank} → consolidation result
 */

export type MnemosyneMemoryMode = "hybrid" | "active" | "passive";
export type BankScope = "exact" | "project" | "hybrid";
/** Named write target; single-bank scopes collapse both targets onto one bank. */
export type BankTarget = "global" | "project";

export interface MnemosyneConfig {
  url: string;
  token: string;
  insecure: boolean;
  memoryMode: MnemosyneMemoryMode;
  topK: number;
  bank: string;
  bankScope: BankScope;
  legacyBanks: string[];
  captureTurns: boolean;
  distillModel: string;
  consolidateOnShutdown: boolean;
  requestTimeoutMs: number;
}

export interface MemoryItem {
  id: string;
  memory: string;
  score?: number;
}

const CONFIG_FILENAME = "config.json";
const DEFAULT_URL = "https://mnemosyne.paragraph.red/mcp";

// mnemosyne/core/banks.py `_validate_bank_name`: alphanumeric, hyphen,
// underscore, at most 64 chars. The bank name is also a server-side
// directory under /data/banks/, so it cannot contain slashes or dots.
const BANK_NAME_MAX = 64;
const PROJECT_PREFIX = "project--";
const PATH_HASH_LEN = 8;

export function invalidBankReason(bank: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(bank)) {
    return `bank "${bank}" may contain only letters, digits, hyphens, and underscores`;
  }
  if (bank.length > BANK_NAME_MAX) {
    return `bank "${bank}" exceeds ${BANK_NAME_MAX} chars (mnemosyne limit)`;
  }
  return undefined;
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    return process.env[name] ?? fallback ?? "";
  });
}

function expandConfig<T>(value: T): T {
  if (typeof value === "string") return expandEnvVars(value) as unknown as T;
  if (Array.isArray(value)) return value.map(expandConfig) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandConfig(v);
    return out as unknown as T;
  }
  return value;
}

function readConfigFile(): Record<string, unknown> {
  const configPath = path.join(getAgentDir(), "extensions", "mnemosyne", CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    // ENOENT is normal: the extension is simply not configured.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.error(
      `[mnemosyne] cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `[mnemosyne] invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function normalizeMemoryMode(v: unknown): MnemosyneMemoryMode {
  return v === "active" || v === "passive" || v === "hybrid" ? v : "hybrid";
}

export function loadMnemosyneConfig(): MnemosyneConfig | undefined {
  const cfg = expandConfig(readConfigFile()) as Record<string, unknown>;

  const url = (typeof cfg.url === "string" && cfg.url.trim()) || process.env.MNEMOSYNE_URL || DEFAULT_URL;
  const token =
    (typeof cfg.token === "string" && cfg.token.trim()) ||
    process.env.MEMORY_MCP_TOKEN ||
    process.env.MNEMOSYNE_MCP_TOKEN ||
    "";
  if (!url || !token) return undefined;

  const bank = (typeof cfg.bank === "string" && cfg.bank.trim()) || "default";
  const bankScope: BankScope =
    cfg.bankScope === "project" || cfg.bankScope === "hybrid" ? cfg.bankScope : "exact";
  const bankProblem = invalidBankReason(bank);
  if (bankProblem) {
    console.error(`[mnemosyne] ${bankProblem}; extension disabled`);
    return undefined;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
    insecure: cfg.insecure === true || process.env.MNEMOSYNE_INSECURE === "1",
    memoryMode: normalizeMemoryMode(cfg.memoryMode),
    topK: typeof cfg.topK === "number" && cfg.topK > 0 ? Math.min(cfg.topK, 50) : 5,
    bank,
    bankScope,
    legacyBanks: parseLegacyBanks(cfg.legacyBanks),
    captureTurns: cfg.captureTurns === true,
    distillModel:
      typeof cfg.distillModel === "string" && cfg.distillModel.trim()
        ? cfg.distillModel.trim()
        : "openai/gpt-5.6-luna",
    consolidateOnShutdown: cfg.consolidateOnShutdown !== false,
    requestTimeoutMs:
      typeof cfg.requestTimeoutMs === "number" && cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : 15000,
  };
}

export interface BankSet {
  /** Banks in use this session; a single element unless scope is hybrid. */
  all: string[];
  /** Bank used when a write does not name a target. */
  defaultWrite: string;
  resolve(target?: BankTarget): string;
}

/**
 * Derive the project bank name from the absolute working directory:
 * `project--` + path with the leading slash stripped and every character
 * outside [A-Za-z0-9_-] collapsed to `-` (for example
 * /Users/dzaitsev/dev/moneyme → project--Users-dzaitsev-dev-moneyme).
 * Encodings longer than the 64-char bank limit are truncated and suffixed
 * with a hash of the full path so distinct projects stay distinct.
 */
export function projectBankName(cwd: string): string {
  const resolved = path.resolve(cwd);
  const encoded = resolved.replace(/^\/+/, "").replace(/[^A-Za-z0-9_-]/g, "-");
  const budget = BANK_NAME_MAX - PROJECT_PREFIX.length - (PATH_HASH_LEN + 1);
  if (encoded.length <= budget) return `${PROJECT_PREFIX}${encoded}`;
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, PATH_HASH_LEN);
  return `${PROJECT_PREFIX}${encoded.slice(0, budget)}-${hash}`;
}

/** Read-only extra banks (renamed-away names) kept in the recall set. */
function parseLegacyBanks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((b): b is string => typeof b === "string" && b.trim() !== "")
    .map((b) => b.trim())
    .filter((b) => {
      const problem = invalidBankReason(b);
      if (problem) console.error(`[mnemosyne] ignoring legacy bank: ${problem}`);
      return !problem;
    });
}

/**
 * Resolve the bank set for a session. The base bank must already be
 * validated by loadMnemosyneConfig. Project banks are named from the cwd
 * path via projectBankName().
 *
 * "exact" and "project" resolve to a single write bank and collapse both
 * write targets onto it. "hybrid" keeps the base bank as a shared global
 * bank alongside the project bank: reads fan out over both, writes default
 * to the project bank, and resolve() routes an explicit target. legacyBanks
 * (renamed-away names) are appended to the read set and never written, so
 * rows there keep recalling until migrated out.
 */
export function resolveBanks(
  cfg: Pick<MnemosyneConfig, "bank" | "bankScope" | "legacyBanks">,
  cwd: string,
): BankSet {
  const project = projectBankName(cwd);
  const banks =
    cfg.bankScope === "exact"
      ? [cfg.bank]
      : cfg.bankScope === "project"
        ? [project]
        : [cfg.bank, project];
  const all = [...banks, ...cfg.legacyBanks.filter((b) => !banks.includes(b))];
  return {
    all,
    defaultWrite: cfg.bankScope === "exact" ? cfg.bank : project,
    resolve: (target) =>
      cfg.bankScope === "hybrid" && target === "global"
        ? cfg.bank
        : cfg.bankScope === "exact"
          ? cfg.bank
          : project,
  };
}

interface ToolPayload {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { message?: string; code?: number };
  id?: number | string;
}

class McpHttpClient {
  private readonly cfg: Pick<MnemosyneConfig, "url" | "token" | "insecure" | "requestTimeoutMs">;
  private sessionId: string | undefined;
  private nextId = 1;
  private initPromise: Promise<void> | undefined;

  constructor(cfg: Pick<MnemosyneConfig, "url" | "token" | "insecure" | "requestTimeoutMs">) {
    this.cfg = cfg;
  }

  async stats(bank: string): Promise<Record<string, unknown>> {
    return this.call("mnemosyne_stats", { bank });
  }

  async recall(query: string, limit: number, bank: string): Promise<MemoryItem[]> {
    const payload = await this.call("mnemosyne_recall", { query, limit, bank });
    return toItems(payload);
  }

  async get(memoryId: string, bank: string): Promise<Record<string, unknown> | undefined> {
    const payload = await this.call("mnemosyne_get", { memory_id: memoryId, bank });
    if (payload.status === "not_found") return undefined;
    const memory = payload.memory;
    return memory && typeof memory === "object" ? (memory as Record<string, unknown>) : payload;
  }

  async remember(args: {
    content: string;
    importance?: number;
    source: string;
    scope: "session" | "global";
    bank: string;
    extract?: boolean;
  }): Promise<string> {
    const payload = await this.call("mnemosyne_remember", {
      content: args.content,
      ...(args.importance !== undefined ? { importance: args.importance } : {}),
      ...(args.extract ? { extract: true } : {}),
      source: args.source,
      scope: args.scope,
      bank: args.bank,
    });
    const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
    if (payload.status !== "stored" || !memoryId) {
      throw new Error(`Unexpected remember result: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return memoryId;
  }

  async forget(memoryId: string, bank: string): Promise<"deleted" | "not_found"> {
    const payload = await this.call("mnemosyne_forget", { memory_id: memoryId, bank });
    return payload.status === "deleted" ? "deleted" : "not_found";
  }

  async sleep(bank: string): Promise<Record<string, unknown>> {
    return this.call("mnemosyne_sleep", { bank });
  }

  async close(): Promise<void> {
    // Nothing persistent to close: each request is a plain HTTPS call.
    this.sessionId = undefined;
    this.initPromise = undefined;
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureInit();
    try {
      return await this.requestTool(tool, args);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      // The server may drop the session (restart, expiry). One re-init and retry.
      this.initPromise = undefined;
      this.sessionId = undefined;
      await this.ensureInit();
      return await this.requestTool(tool, args);
    }
  }

  private ensureInit(): Promise<void> {
    this.initPromise ??= this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mnemosyne", version: "1.0.0" },
      },
    });
    this.sessionId = res.headers["mcp-session-id"];
    // Protocol requires the initialized notification after a successful handshake.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
  }

  private async requestTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const message = payload.json;
    if (message.error) {
      throw new Error(`MCP error: ${message.error.message ?? JSON.stringify(message.error)}`);
    }
    const result = message.result;
    if (!result) throw new Error(`Empty response for ${tool}.`);
    const text = result.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";
    const nested = parseMaybeJson(text) as Record<string, unknown> | undefined;
    if (result.isError || nested?.isError === true) {
      throw new Error(text.slice(0, 500) || `${tool} failed.`);
    }
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent as Record<string, unknown>;
    }
    const parsed = parseMaybeJson(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { raw: text };
  }

  private post(body: unknown, isNotification = false): Promise<{ headers: Record<string, string>; json: ToolPayload }> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.cfg.url);
      const isTls = url.protocol === "https:";
      const transport = isTls ? https : http;
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isTls ? 443 : 80),
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${this.cfg.token}`,
            ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          },
          ...(isTls ? { rejectUnauthorized: !this.cfg.insecure } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const headers = Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : String(v ?? "")]),
            );
            if (res.statusCode && res.statusCode >= 400) {
              reject(new HttpError(res.statusCode, text.slice(0, 500)));
              return;
            }
            if (isNotification) {
              resolve({ headers, json: {} });
              return;
            }
            const json = extractJsonRpc(text, headers["content-type"] ?? "");
            if (!json) {
              reject(new Error(`Unparseable response (${headers["content-type"]}): ${text.slice(0, 200)}`));
              return;
            }
            resolve({ headers, json });
          });
        },
      );
      req.setTimeout(this.cfg.requestTimeoutMs, () => {
        req.destroy(new Error(`Mnemosyne request timed out after ${this.cfg.requestTimeoutMs}ms.`));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
}

class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

function isSessionError(err: unknown): boolean {
  if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("session") && (msg.includes("expired") || msg.includes("unknown") || msg.includes("not found"));
}

function extractJsonRpc(text: string, contentType: string): ToolPayload | undefined {
  if (contentType.includes("text/event-stream")) {
    // The streamable-HTTP spec allows SSE-framed responses; this server
    // answers with plain JSON, but accept both.
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = parseMaybeJson(line.slice(5).trim()) as ToolPayload | undefined;
      if (parsed && ("result" in parsed || "error" in parsed)) return parsed;
    }
    return undefined;
  }
  return parseMaybeJson(text) as ToolPayload | undefined;
}

function parseMaybeJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toItems(payload: Record<string, unknown>): MemoryItem[] {
  const raw = Array.isArray(payload.results) ? payload.results : [];
  return raw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((item) => {
      const id = typeof item.id === "string" ? item.id : String(item.memory_id ?? "");
      const memory =
        typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : "";
      const score = typeof item.score === "number" ? item.score : undefined;
      return { id, memory, score };
    })
    .filter((item) => item.id !== "" && item.memory.trim() !== "");
}

export interface MnemosyneProvider {
  stats(bank: string): Promise<Record<string, unknown>>;
  search(query: string, topK: number, bank: string): Promise<MemoryItem[]>;
  get(memoryId: string, bank: string): Promise<Record<string, unknown> | undefined>;
  add(text: string, bank: string, importance?: number): Promise<string>;
  saveFacts(facts: string[], bank: string): Promise<void>;
  delete(memoryId: string, bank: string): Promise<"deleted" | "not_found">;
  sleep(bank: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export const FACT_SOURCE = "pi-fact";
export const FACT_IMPORTANCE = 0.5;

export function createMnemosyneProvider(cfg: MnemosyneConfig): MnemosyneProvider {
  const client = new McpHttpClient(cfg);
  return {
    stats: (bank) => client.stats(bank),
    search: (query, topK, bank) => client.recall(query, topK, bank),
    get: (memoryId, bank) => client.get(memoryId, bank),
    add: (text, bank, importance) =>
      client.remember({ content: text, importance, source: "pi", scope: "global", bank }),
    saveFacts: (facts, bank) =>
      Promise.all(
        facts.map((fact) =>
          client.remember({
            content: fact,
            importance: FACT_IMPORTANCE,
            source: FACT_SOURCE,
            scope: "global",
            bank,
          }),
        ),
      ).then(() => undefined),
    delete: (memoryId, bank) => client.forget(memoryId, bank),
    sleep: (bank) => client.sleep(bank),
    close: () => client.close(),
  };
}

/**
 * Recall from every bank in parallel and merge the ranked lists. One
 * failing bank must not sink the others, so failures log and yield nothing.
 */
export async function searchBanks(
  provider: Pick<MnemosyneProvider, "search">,
  query: string,
  limit: number,
  banks: string[],
): Promise<MemoryItem[]> {
  const groups = await Promise.all(
    banks.map((bank) =>
      provider.search(query, limit, bank).catch((err: unknown) => {
        console.error(
          `[mnemosyne] recall on bank ${bank} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as MemoryItem[];
      }),
    ),
  );
  return mergeRecallResults(groups, limit);
}

/** Merge ranked lists: score-descending, stable for ties (earlier bank
 * first), duplicate ids dropped, capped at limit. */
export function mergeRecallResults(groups: MemoryItem[][], limit: number): MemoryItem[] {
  const seen = new Set<string>();
  return groups
    .flat()
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, limit);
}
