/**
 * Security boundaries for recalled memory — same contract as the mem0 and
 * vault extensions: credentials are redacted before storage; memory text
 * returned to the model is threat-scanned and wrapped as untrusted data.
 * Never inject recalled memory into the system prompt.
 */

export function redactMemoryText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi, "$1=[REDACTED]");
}

const THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(all|any|previous|prior|above|earlier)\s+(instructions|prompts?|rules?|directives?)/i,
  /disregard\s+(all|any|the\s+)?(previous|above|prior|earlier)?\s*(instructions|prompts?|rules?)/i,
  /\bsystem\s+(prompt|message|instructions)\s*[:=]/i,
  /\b(developer|god|dan)\s+mode\b/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /\b(jailbreak|sandbox\s+escape)\b/i,
  /<\|im_start\|>|<\/?(system|tool)>/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /^\s*(new|updated|override)\s+instructions\s*:/im,
];

export function scanForThreats(text: string): string[] {
  const findings: string[] = [];
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) findings.push(pattern.source.slice(0, 60));
  }
  return findings;
}

export function formatRecalledMemory(text: string): string {
  const findings = scanForThreats(text);
  if (findings.length > 0) {
    return `[BLOCKED UNTRUSTED MEMORY: ${findings.join(", ")}]`;
  }
  // Collapse whitespace: memory rows may be multi-line, and injected recall
  // lines must stay single-line (hermes provider does the same).
  return `[UNTRUSTED MEMORY DATA] ${text.replace(/\s+/g, " ").trim()}`;
}
