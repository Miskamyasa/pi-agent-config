/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentDiscoveryOptions {
	/** Discard instruction bodies. Use when only names and descriptions are needed. */
	metadataOnly?: boolean;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project", metadataOnly = false): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			// A malformed file must not break discovery for the other agents.
			continue;
		}

		const { name, description } = frontmatter;

		if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
			continue;
		}

		const rawTools = frontmatter.tools;
		let tools: string[] | undefined;
		if (typeof rawTools === "string") {
			const parsedTools = rawTools
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			if (parsedTools.length > 0) tools = parsedTools;
		}

		const rawModel = frontmatter.model;

		agents.push({
			name,
			description,
			tools,
			model: typeof rawModel === "string" ? rawModel : undefined,
			systemPrompt: metadataOnly ? "" : body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	options: AgentDiscoveryOptions = {},
): AgentDiscoveryResult {
	const metadataOnly = options.metadataOnly ?? false;
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", metadataOnly);
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", metadataOnly);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** Format agents as one line, for example `scout (user): research with evidence`. */
export function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
}
