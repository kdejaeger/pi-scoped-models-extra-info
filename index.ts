/**
 * /scoped-models-extra-info — Pi coding agent extension
 *
 * Renders an interactive table of your enabled (scoped) models with:
 * model slug, input price, output price, context window, input modalities,
 * thinking levels, and Artificial Analysis coding benchmarks.
 *
 * Press Enter on a row to switch to that model.
 * Shortcut: Ctrl+Alt+F
 *
 * Environment variables:
 *   AA_API_KEY  — Artificial Analysis API key for coding index column (optional).
 *                 Get one at https://artificialanalysis.ai
 *                 Without it, the coding index column is omitted.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, getModels, getProviders } from "@earendil-works/pi-ai";
import { truncateToWidth, matchesKey, visibleWidth, Key } from "@earendil-works/pi-tui";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";

// ── Config ─────────────────────────────────────────────────────────────────

const AA_API_KEY = process.env.AA_API_KEY || "";
const AA_API_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const AA_CACHE_DIR = homedir() + "/.cache/pi/scoped-models-extra-info";
const AA_CACHE_FILE = AA_CACHE_DIR + "/aa-models.json";
const AA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Model data helpers ─────────────────────────────────────────────────────

interface ModelRow {
	slug: string;
	inputPrice: number;
	outputPrice: number;
	contextWindow: number;
	codingIndex: string;
	codingSortValue: number;
	thinkingLevels: string;
	inputModalities: string;
	provider: string;
	modelId: string;
}

function getSlug(model: { provider: string; id: string; name: string }): string {
	const shortId = model.id.startsWith("~") ? model.id.slice(1) : model.id;
	return `${model.provider}/${shortId}`;
}

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Normalize a provider name by stripping common artifacts (hyphens, "-" at end, etc.)
 * so we can match across pi's internal provider naming and OpenRouter sub-provider prefixes.
 */
function normalizeProvider(name: string): string {
	return name.replace(/-/g, "").toLowerCase();
}

/**
 * Resolve thinking levels for a model, falling back to the native model's
 * thinkingLevelMap when the model itself doesn't have one (common for
 * OpenRouter proxies that inherit the native model's thinking capabilities).
 */
function resolveThinkingLevels(model: { reasoning: boolean; id: string; thinkingLevelMap?: Record<string, string | null> }): string[] {
	// If the model already has a thinkingLevelMap, use it directly
	if (model.thinkingLevelMap) {
		return getSupportedThinkingLevels(model as any);
	}
	// Try to find the native model from the model ID
	// e.g., model.id = "google/gemma-4-31b-it" → native provider "google", short name "gemma-4-31b-it"
	const slashIdx = model.id.indexOf("/");
	if (slashIdx > 0) {
		const rawProvider = model.id.slice(0, slashIdx);
		const shortName = model.id.slice(slashIdx + 1);

		// Helper: try to find a native model with thinkingLevelMap in a given provider
		const findInProvider = (provider: string) => {
			const nativeModels = getModels(provider);
			return nativeModels.find((m: any) => m.id === shortName && m.thinkingLevelMap);
		};

		// 1. Try the raw provider name directly
		let nativeModel = findInProvider(rawProvider);
		if (nativeModel) {
			const merged = { ...model, thinkingLevelMap: nativeModel.thinkingLevelMap };
			return getSupportedThinkingLevels(merged as any);
		}

		// 2. Try normalized provider (strip hyphens, lowercase)
		const normProvider = normalizeProvider(rawProvider);
		if (normProvider !== rawProvider.toLowerCase()) {
			nativeModel = findInProvider(normProvider);
			if (nativeModel) {
				const merged = { ...model, thinkingLevelMap: nativeModel.thinkingLevelMap };
				return getSupportedThinkingLevels(merged as any);
			}
		}

		// 3. Fall back to scanning all providers for the short name
		const providers = getProviders();
		for (const prov of providers) {
			if (prov === rawProvider || prov === normProvider) continue; // already tried
			nativeModel = findInProvider(prov);
			if (nativeModel) {
				const merged = { ...model, thinkingLevelMap: nativeModel.thinkingLevelMap };
				return getSupportedThinkingLevels(merged as any);
			}
		}
	}
	return getSupportedThinkingLevels(model as any);
}

const THINKING_LEVEL_SLOTS: ReadonlyArray<[string, number]> = [
	["off", 4],
	["minimal", 8],
	["low", 4],
	["medium", 7],
	["high", 5],
	["xhigh", 5],
];

function getThinkingLevelsLabel(model: { reasoning: boolean }, levels: string[]): string {
	if (!model.reasoning) return "—";
	const levelSet = new Set(levels);
	let result = "";
	for (const [level, width] of THINKING_LEVEL_SLOTS) {
		if (levelSet.has(level)) {
			result += level.padEnd(width);
		} else {
			result += " ".repeat(width);
		}
	}
	return result;
}

function getInputModalitiesLabel(modalities: string[]): string {
	if (modalities.includes("image")) return "text+img";
	return "text";
}

function formatPrice(price: number): string {
	if (price >= 10) {
		return `$${Math.round(price)}`;
	}
	return `$${price.toFixed(2)}`;
}

function formatContextWindow(window: number): string {
	if (window >= 1_000_000) {
		return `${(window / 1_000_000).toFixed(1)}M`;
	}
	return `${Math.round(window / 1000)}K`;
}

/** Pad a plain text string to a target visible width by appending spaces. */
function padVisible(text: string, width: number): string {
	const cur = visibleWidth(text);
	const needed = width - cur;
	if (needed > 0) return text + " ".repeat(needed);
	return text;
}

/** Fit plain text into a fixed-width cell (truncate then pad). */
function padVisibleLeft(text: string, width: number): string {
	const cur = visibleWidth(text);
	const needed = width - cur;
	if (needed > 0) return " ".repeat(needed) + text;
	return text;
}

function padVisibleRight(text: string, width: number): string {
	const cur = visibleWidth(text);
	const needed = width - cur;
	if (needed > 0) return text + " ".repeat(needed);
	return text;
}

/** Simple truncation that cuts text at maxWidth visible columns without adding "...". */
function truncatePlain(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let result = "";
	let w = 0;
	for (const ch of text) {
		const cw = visibleWidth(ch);
		if (w + cw > maxWidth) break;
		result += ch;
		w += cw;
	}
	return result;
}

function fitCell(text: string, width: number, align: "left" | "right" = "left"): string {
	const fitted = truncatePlain(text, width);
	return align === "right" ? padVisibleLeft(fitted, width) : padVisibleRight(fitted, width);
}

// ── Artificial Analysis data ───────────────────────────────────────────────

interface AAModelEntry {
	name: string;
	slug: string;
	model_creator: { name: string; slug?: string };
	evaluations: { artificial_analysis_coding_index?: number };
}

/** Slug suffix → pi thinking level mapping (longest-first). */
const SUFFIX_TO_LEVEL: ReadonlyArray<{ suffix: string; level: string }> = [
	{ suffix: "-non-reasoning-low-effort", level: "off" },
	{ suffix: "-non-reasoning-high-effort", level: "off" },
	{ suffix: "-non-reasoning", level: "off" },
	{ suffix: "-low-effort", level: "low" },
	{ suffix: "-low", level: "low" },
	{ suffix: "-medium", level: "medium" },
	{ suffix: "-high-effort", level: "high" },
	{ suffix: "-high", level: "high" },
	{ suffix: "-minimal", level: "minimal" },
	{ suffix: "-adaptive", level: "xhigh" },
];

/** Wider slots for coding column: "level(99.9)" per slot, +1 for spacing */
const CODING_SLOTS: ReadonlyArray<[string, number]> = [
	["off", 10],
	["minimal", 14],
	["low", 10],
	["medium", 13],
	["high", 11],
	["xhigh", 12],
];

/** per-model: baseKey → Map<thinkingLevel, codingIndex> */
type AAModelLevels = Map<string, Map<string, number>>;

let aaModelData: AAModelLevels | null = null;
let aaReady: Promise<void> | null = null;

/** Extract base slug and pi thinking level from an AA entry slug. */
function parseEntryLevel(slug: string, name: string): { baseSlug: string; level: string } | null {
	const s = slug.toLowerCase();
	for (const { suffix, level } of SUFFIX_TO_LEVEL) {
		if (s.endsWith(suffix)) {
			const base = s.slice(0, -suffix.length);
			if (base.length > 0) return { baseSlug: base, level };
		}
	}
	// No known slug suffix — check name for reasoning-mode hints
	const n = name.toLowerCase();
	const nameLevelRe = /\(\s*(minimal|low|medium|high|xhigh|non.reasoning|non reasoning|reasoning)\s*\)/;
	const nameMatch = n.match(nameLevelRe);
	if (nameMatch) {
		const raw = nameMatch[1].replace(/[^a-z]/g, "");
		const level = raw === "nonreasoning" ? "off" : raw === "reasoning" ? "high" : raw;
		return { baseSlug: s, level };
	}
	// Check for "Max Effort" (maps to xhigh)
	if (n.includes("max effort")) {
		return { baseSlug: s, level: "xhigh" };
	}
	// Final fallback: high — most reasoning models default here, xhigh only when specified
	return { baseSlug: s, level: "high" };
}

function buildAAModelData(data: AAModelEntry[]): AAModelLevels {
	const map: AAModelLevels = new Map();
	for (const entry of data) {
		const ci = entry.evaluations?.artificial_analysis_coding_index;
		if (ci == null) continue;
		const parsed = parseEntryLevel(entry.slug, entry.name);
		if (!parsed) continue;
		const key = `${(entry.model_creator.slug ?? entry.model_creator.name).toLowerCase()}/${parsed.baseSlug}`;
		let levelMap = map.get(key);
		if (!levelMap) {
			levelMap = new Map();
			map.set(key, levelMap);
		}
		// Keep highest CI when the same base+level appears in multiple AA entries
		const existing = levelMap.get(parsed.level);
		if (existing === undefined || ci > existing) {
			levelMap.set(parsed.level, ci);
		}
	}
	return map;
}

function findLevelMap(
	provider: string,
	modelId: string,
	data: AAModelLevels,
): Map<string, number> | undefined {
	const p = provider.toLowerCase();
	const mid = modelId.toLowerCase().replace(/\./g, "-");

	/** Collect normalized forms (with date stripping) for a model name. */
	const normalForms = (name: string): string[] => {
		const r = [name];
		const s1 = name.replace(/-\d{4}-\d{2}-\d{2}(?:-\d+)?$/, "");
		if (s1 !== name) r.push(s1);
		const s2 = name.replace(/-\d{8}$/, "");
		if (s2 !== name && s2 !== s1) r.push(s2);
		return r;
	};

	/** Try exact lookup with a given (provider, model) pair. */
	const tryLookup = (pr: string, md: string): Map<string, number> | undefined => {
		for (const c of normalForms(md)) {
			const found = data.get(`${pr}/${c}`);
			if (found) return found;
		}
		return undefined;
	};

	/** Try prefix matching with a given (provider, model) pair. */
	const tryPrefix = (pr: string, md: string): Map<string, number> | undefined => {
		for (const [key, val] of data) {
			if (key.startsWith(pr + "/") && md.startsWith(key.slice(pr.length + 1))) return val;
		}
		const norm = normalForms(md);
		for (const [key, val] of data) {
			if (key.startsWith(pr + "/")) {
				const aaSlug = key.slice(pr.length + 1);
				for (const c of norm) {
					if (aaSlug.startsWith(c)) return val;
				}
			}
		}
		return undefined;
	};

	// 1. Try pi's provider directly (e.g. openrouter/deepseek-v4-flash)
	const hit1 = tryLookup(p, mid);
	if (hit1) return hit1;

	// 2. ModelId may contain a sub-provider, e.g. "deepseek/deepseek-v4-flash"
	const slashIdx = mid.indexOf("/");
	if (slashIdx >= 0) {
		const rawProvider = mid.slice(0, slashIdx);
		const rawModel = mid.slice(slashIdx + 1);
		const realProvider = rawProvider.replace(/^~/, "");
		const hit2 = tryLookup(realProvider, rawModel);
		if (hit2) return hit2;
		const hit3 = tryPrefix(realProvider, rawModel);
		if (hit3) return hit3;
	}

	// 3. Fallback: prefix matching with pi's provider
	const hit4 = tryPrefix(p, mid);
	if (hit4) return hit4;

	// 4. Try common provider aliases (e.g. openai-codex → openai)
	const aliasMap: Record<string, string> = {
		"openai-codex": "openai",
		"qwen": "alibaba",
		"moonshotai": "kimi",
		"arcee-ai": "arcee ai",
		"z-ai": "zai",
	};
	const alias = aliasMap[p];
	if (alias) {
		const hit5 = tryLookup(alias, mid);
		if (hit5) return hit5;
	}
	// Also try sub-provider aliased (e.g. qwen → alibaba)
	if (slashIdx >= 0) {
		const rawProvider = mid.slice(0, slashIdx);
		const rawModel = mid.slice(slashIdx + 1);
		const realProvider = rawProvider.replace(/^~/, "");
		const subAlias = aliasMap[realProvider];
		if (subAlias) {
			const hit6 = tryLookup(subAlias, rawModel);
			if (hit6) return hit6;
			const hit6b = tryPrefix(subAlias, rawModel);
			if (hit6b) return hit6b;
		}
		// Also try stripped-hyphen provider (e.g. "z-ai" → "zai")
		const strippedProvider = realProvider.replace(/-/g, "");
		if (strippedProvider !== realProvider) {
			const hit6c = tryLookup(strippedProvider, rawModel);
			if (hit6c) return hit6c;
			const hit6d = tryPrefix(strippedProvider, rawModel);
			if (hit6d) return hit6d;
		}
	}

	// 5. Clean model name (strip ":free", "-latest" etc.) and retry
	const cleanMid = mid.replace(/:.*$/, "").replace(/-latest$/, "");
	if (cleanMid !== mid) {
		const hit7 = tryLookup(p, cleanMid);
		if (hit7) return hit7;
		if (slashIdx >= 0) {
			const rawProvider = mid.slice(0, slashIdx);
			const rawModel = mid.slice(slashIdx + 1);
			const cleanModel = rawModel.replace(/:.*$/, "").replace(/-latest$/, "");
			const realProvider = rawProvider.replace(/^~/, "");
			const hit8 = tryLookup(realProvider, cleanModel);
			if (hit8) return hit8;
			const hit9 = tryPrefix(realProvider, cleanModel);
			if (hit9) return hit9;
			const subAlias = aliasMap[realProvider];
			if (subAlias) {
				const hit10 = tryLookup(subAlias, cleanModel);
				if (hit10) return hit10;
			}
		}
	}

	return undefined;
}

/** Format level→CI map as display string + sort value (by "high" level CI). */
function formatCodingData(levelMap: Map<string, number>): { display: string; sortValue: number } {
	let display = "";
	let sortValue = -1;
	for (const [level, width] of CODING_SLOTS) {
		const ci = levelMap.get(level);
		if (ci != null) {
			display += `${level}(${ci.toFixed(1)})`.padEnd(width);
			if (level === "high") sortValue = ci;
		} else {
			display += " ".repeat(width);
		}
	}
	if (sortValue < 0) {
		for (const level of ["xhigh", "medium", "low", "minimal", "off"]) {
			const ci = levelMap.get(level);
			if (ci != null) { sortValue = ci; break; }
		}
	}
	return { display, sortValue };
}

async function fetchAAData(): Promise<void> {
	if (!AA_API_KEY) return;
	try {
		const resp = await fetch(AA_API_URL, { headers: { "x-api-key": AA_API_KEY } });
		if (!resp.ok) {
			try {
				const raw = readFileSync(AA_CACHE_FILE, "utf-8");
				aaModelData = buildAAModelData(JSON.parse(raw) as AAModelEntry[]);
			} catch { /* no stale cache */ }
			return;
		}
		const json = await resp.json();
		const data = json.data as AAModelEntry[];
		aaModelData = buildAAModelData(data);
		try {
			mkdirSync(AA_CACHE_DIR, { recursive: true });
			writeFileSync(AA_CACHE_FILE, JSON.stringify(data));
		} catch { /* cache write failure is non-fatal */ }
	} catch {
		try {
			const raw = readFileSync(AA_CACHE_FILE, "utf-8");
			aaModelData = buildAAModelData(JSON.parse(raw) as AAModelEntry[]);
		} catch { /* no stale cache either */ }
	}
}

function initAAData(): boolean {
	if (!AA_API_KEY) return false;
	// Try to load cache regardless of age — stale data is better than blocking.
	try {
		const raw = readFileSync(AA_CACHE_FILE, "utf-8");
		aaModelData = buildAAModelData(JSON.parse(raw) as AAModelEntry[]);
		// If cache is stale, fire a background refresh (no await).
		try {
			const s = statSync(AA_CACHE_FILE);
			if (Date.now() - s.mtimeMs >= AA_CACHE_TTL_MS) {
				aaReady = fetchAAData(); // background — never awaited
			}
		} catch { /* stat failed, ignore */ }
		return true; // data loaded from cache (possibly stale)
	} catch { /* no cache file */ }
	// No cache at all — fire background fetch, return false.
	aaReady = fetchAAData();
	return false;
}

// ── Terminal table component ───────────────────────────────────────────────

type SortColumn = "name" | "input" | "output" | "coding";

class ExtraInfoTable {
	private rows: ModelRow[];
	private pi: ExtensionAPI;
	private ctx: ExtensionCommandContext;
	private theme: Theme;
	private done: (value: string | undefined) => void;
	private scrollOffset = 0;
	selectedIndex = 0;
	private sortColumn: SortColumn = "output";
	private sortDirection: "asc" | "desc" = "asc";
	private cachedLines: string[] | undefined;

	constructor(
		rows: ModelRow[],
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		theme: Theme,
		done: (value: string | undefined) => void,
	) {
		this.rows = rows;
		this.pi = pi;
		this.ctx = ctx;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}

		// ── Sort shortcuts ──
		if (matchesKey(data, "n")) {
			this.sortBy("name");
			return;
		}
		if (matchesKey(data, "i")) {
			this.sortBy("input");
			return;
		}
		if (matchesKey(data, "o")) {
			this.sortBy("output");
			return;
		}
		if (matchesKey(data, "c")) {
			this.sortBy("coding");
			return;
		}

		// ── Navigation ──
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
			this.ensureVisible();
			this.invalidate();
			return;
		}

		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			this.selectedIndex = this.rows.length - 1;
			this.scrollOffset = Math.max(0, this.rows.length - this.maxVisibleRows());
			this.invalidate();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "space")) {
			const row = this.rows[this.selectedIndex];
			if (!row) return;
			this.done(`${row.provider}/${row.modelId}`);
			return;
		}
	}

	private sortBy(column: SortColumn): void {
		if (this.sortColumn === column) {
			// Toggle direction
			this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
		} else {
			this.sortColumn = column;
			this.sortDirection = "asc";
		}

		const dir = this.sortDirection === "asc" ? 1 : -1;
		this.rows.sort((a, b) => {
			let cmp: number;
			switch (column) {
				case "name":
					cmp = a.slug.localeCompare(b.slug);
					break;
				case "input":
					cmp = a.inputPrice - b.inputPrice;
					break;
				case "output":
					cmp = a.outputPrice - b.outputPrice;
					break;
				case "coding": {
					const aVal = a.codingSortValue;
					const bVal = b.codingSortValue;
					cmp = aVal - bVal;
					break;
				}
			}
			return cmp * dir;
		});

		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.invalidate();
	}

	private maxVisibleRows(): number {
		return Math.min(this.rows.length, 20);
	}

	ensureVisible(): void {
		const maxVis = this.maxVisibleRows();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + maxVis) {
			this.scrollOffset = this.selectedIndex - maxVis + 1;
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;

		const t = this.theme;
		const accent = (s: string) => t.fg("accent", s);
		const text = (s: string) => t.fg("text", s);
		const muted = (s: string) => t.fg("muted", s);
		const dim = (s: string) => t.fg("dim", s);
		const success = (s: string) => t.fg("success", s);

		const arrow = this.sortDirection === "asc" ? ">" : "<";
		const sortMarker = (col: SortColumn): string =>
			this.sortColumn === col ? success(arrow) : "";

		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// Column widths (visible character counts)
		const colSlug = 50;
		const colIn = 7;
		const colOut = 8;
		const colCtx = 7;
		const colCode = 70;
		const colThink = 33;
		const colMod = 10;

		// Build separator AFTER deciding column widths (so we can compute total)
		const sep = " | ";
		const rowWidth = colSlug + colIn + colOut + colCtx + colCode + colThink + colMod + sep.length * 6;

		// ── Header ──
		add("");

		const headerCells = [
			fitCell(`Model${sortMarker("name")}`, colSlug, "left"),
			fitCell(`Input$${sortMarker("input")}`, colIn, "right"),
			fitCell(`Output$${sortMarker("output")}`, colOut, "right"),
			fitCell("Context", colCtx, "right"),
			fitCell("Modalities", colMod, "left"),
			fitCell("Thinking", colThink, "left"),
			fitCell(`Coding index${sortMarker("coding")}`, colCode, "left"),
		];
		add(accent("  " + headerCells.join(sep)));

		// Separator line
		add(dim("  " + "-".repeat(Math.min(width, rowWidth))));

		// ── Data rows ──
		for (let i = this.scrollOffset; i < this.rows.length; i++) {
			const row = this.rows[i];
			const isSelected = i === this.selectedIndex;

			const slugCell = fitCell(row.slug, colSlug, "left");
			const inCell = fitCell(formatPrice(row.inputPrice), colIn, "right");
			const outCell = fitCell(formatPrice(row.outputPrice), colOut, "right");
			const ctxCell = fitCell(formatContextWindow(row.contextWindow), colCtx, "right");
			const modCell = fitCell(row.inputModalities, colMod, "left");
			const thinkCell = fitCell(row.thinkingLevels, colThink, "left");
			const codeCell = fitCell(row.codingIndex, colCode, "left");

			let plainRow = [slugCell, inCell, outCell, ctxCell, modCell, thinkCell, codeCell].join(sep);
			plainRow = truncateToWidth(plainRow, rowWidth);

			if (isSelected) {
				add(accent("> " + plainRow));
			} else {
				add("  " + text(plainRow));
			}
		}

		// ── Footer ──
		add("");
		const scrollInfo =
			this.rows.length > this.maxVisibleRows()
				? `${this.selectedIndex + 1}/${this.rows.length}`
				: `${this.rows.length} models`;
		const footerText = ` ↑↓/jk navigate  •  n/i/o/c sort  •  Enter select  •  q/Esc  •  ${scrollInfo}`;
		add(dim(footerText));
		add(accent("  " + "-".repeat(Math.min(width, rowWidth))));

		this.cachedLines = lines;
		return lines;
	}
}

// ── Extension registration ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("scoped-models-extra-info", {
		description:
			"Render table of scoped models with prices, context window, thinking levels, and modalities",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showScopedModelsTable(pi, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("f"), {
		description: "Open scoped models table",
		handler: async (ctx: ExtensionContext) => {
			await showScopedModelsTable(pi, ctx);
		},
	});
}

async function showScopedModelsTable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Command requires interactive mode", "error");
		return;
	}

	// Read enabled models from settings
	const sm = SettingsManager.create(ctx.cwd);
	const allModels = ctx.modelRegistry.getAvailable();

	// Build a lookup by "provider/id"
	const modelLookup = new Map<string, (typeof allModels)[0]>();
	for (const m of allModels) {
		modelLookup.set(`${m.provider}/${m.id}`, m);
	}

	const globalSettings = sm.getGlobalSettings();
	const enabledPatterns = globalSettings.enabledModels;

	let matchedModels: typeof allModels;

	if (!enabledPatterns || enabledPatterns.length === 0) {
		matchedModels = allModels;
	} else {
		matchedModels = [];

		for (const pattern of enabledPatterns) {
			const firstSlash = pattern.indexOf("/");
			if (firstSlash === -1) continue;

			const provider = pattern.slice(0, firstSlash);
			const modelId = pattern.slice(firstSlash + 1);

			const key = `${provider}/${modelId}`;
			let model = modelLookup.get(key);

			if (!model) {
				model = allModels.find((m) => m.provider === provider && m.id === modelId);
			}

			if (model) {
				matchedModels.push(model);
			}
		}
	}

	if (matchedModels.length === 0) {
		ctx.ui.notify("No available models found", "warning");
		return;
	}

	// Initialize AA data (sync from cache, never blocks on HTTP)
	// If cache is empty or AA_API_KEY unset, data shows without coding index on first load.
	const hasAA = initAAData();

	// Build rows
	const rows = buildRows(matchedModels, aaModelData);

	// Pre-select the currently active model, if it's in the list
	let initialIndex = 0;
	if (ctx.model) {
		const currentSlug = `${ctx.model.provider}/${ctx.model.id}`;
		const found = rows.findIndex((r) => r.slug === currentSlug);
		if (found >= 0) initialIndex = found;
	}

	// Show interactive table
	const selectedPath = await ctx.ui.custom<string | undefined>(
		(_tui, theme, _kb, done) => {
			const table = new ExtraInfoTable(rows, pi, ctx, theme, done);
			table.selectedIndex = initialIndex;
			table.ensureVisible();
			return table;
		},
	);

	// If user selected a model (Enter/Space), switch to it
	if (selectedPath) {
		const firstSlash = selectedPath.indexOf("/");
		const provider = firstSlash >= 0 ? selectedPath.slice(0, firstSlash) : "";
		const modelId = firstSlash >= 0 ? selectedPath.slice(firstSlash + 1) : selectedPath;

		const model = ctx.modelRegistry.find(provider, modelId);
		if (model) {
			const ok = await pi.setModel(model);
			if (ok) {
				ctx.ui.notify(`✓ Switched to ${provider}/${modelId}`, "info");
			} else {
				ctx.ui.notify(`✗ No API key available for ${provider}/${modelId}`, "error");
			}
		} else {
			ctx.ui.notify(`✗ Model ${selectedPath} not found in registry`, "error");
		}
	}
}

// ── Row building ───────────────────────────────────────────────────────────

function buildRows(
	models: {
		provider: string;
		id: string;
		name: string;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		input: string[];
		reasoning: boolean;
	}[],
	aaModelData: AAModelLevels | null,
): ModelRow[] {
	const rows: ModelRow[] = [];

	for (const model of models) {
		const levels = resolveThinkingLevels(model as any);

		// Look up artificial analysis coding index (across all thinking levels)
		let codingIndex = "—";
		let codingSortValue = -1;
		if (aaModelData) {
			const levelMap = findLevelMap(model.provider, model.id, aaModelData);
			if (levelMap) {
				const fmt = formatCodingData(levelMap);
				codingIndex = fmt.display;
				codingSortValue = fmt.sortValue;
			}
		}

		rows.push({
			slug: getSlug(model),
			inputPrice: model.cost.input,
			outputPrice: model.cost.output,
			contextWindow: model.contextWindow,
			codingIndex,
			codingSortValue,
			thinkingLevels: getThinkingLevelsLabel(model, levels),
			inputModalities: getInputModalitiesLabel(model.input),
			provider: model.provider,
			modelId: model.id,
		});
	}

	// Sort by output price ascending
	rows.sort((a, b) => a.outputPrice - b.outputPrice);
	return rows;
}
