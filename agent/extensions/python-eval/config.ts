/**
 * python-eval — tunable values and fixed strings.
 *
 * Values only: no imports and no logic, so every number and sentence the
 * extension uses is reviewable in one place.
 */

/** Hard cap per call. A hung script must not hold the session. */
export const RUN_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const INSTALL_TIMEOUT_MS = 300_000;
/** Collection cap per stream. Bytes past it are dropped but still drained. */
export const MAX_STREAM_BYTES = 1024 * 1024;
export const PARTIAL_UPDATE_MS = 200;
export const PREVIEW_LINES = 10;
/** Tail of a failed pip install kept for the result. */
export const INSTALL_OUTPUT_TAIL_CHARS = 2000;

export const INTERPRETERS =
  process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];

/** Modules whose import name differs from the PyPI distribution name. */
export const MODULE_TO_PACKAGE: Record<string, string> = {
  PIL: "pillow",
  cv2: "opencv-python",
  skimage: "scikit-image",
  sklearn: "scikit-learn",
  yaml: "pyyaml",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  git: "gitpython",
  serial: "pyserial",
  attr: "attrs",
  Crypto: "pycryptodome",
  jose: "python-jose",
  multipart: "python-multipart",
  wx: "wxpython",
};

export const NO_PYTHON_HINT =
  "python_eval found no Python 3 interpreter: tried python3 and python on PATH. " +
  "Install Python 3, or put it on PATH.";

export const TOOL_NAME = "python_eval";
export const TOOL_LABEL = "Python Eval";
export const TOOL_DESCRIPTION =
  "Run inline Python code and return its output. Each call starts a fresh interpreter, so " +
  "imports and variables do not persist between calls. A missing import is installed with " +
  "pip and the code is retried once. A call is killed after 30s. Output is capped at 50KB " +
  "per stream; a non-zero exit code is returned as normal output, not as an error.";
export const TOOL_PROMPT_SNIPPET = "Run inline Python code (fresh interpreter per call).";
export const TOOL_PROMPT_GUIDELINES = [
  "Use python_eval to run inline Python — calculations, data processing, quick scripts — instead of running `python3 -c` through the bash tool.",
  "python_eval is stateless: every call gets a fresh interpreter, so re-import and re-define anything a later call needs.",
  "python_eval installs a missing import once and retries; a non-zero exit code arrives as normal output, so read stderr in the result.",
];
export const CODE_PARAM_DESCRIPTION =
  "Python source to execute with `python -c`. The interpreter is fresh on every call, so imports and variables do not persist.";

/** Fixed text in the rendered views. */
export const STDERR_LABEL = "[stderr]";
export const SOURCE_LABEL = "── source ──";
export const NO_OUTPUT_TEXT = "(no output)";
export const RUNNING_TEXT = "python_eval still running…";
export const EXPAND_HINT = "to expand";
export const GLYPH_OK = "✓";
export const GLYPH_FAIL = "✗";
export const GLYPH_RUNNING = "●";
/** Theme color of the rules that frame the source block, as in edit and write. */
export const FRAME_COLOR = "dim";
