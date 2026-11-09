/**
 * A reproducer for the background bleed seen in Rex Beta, bundled with the renderer it tests.
 *
 * Rex keeps the cursor in a pending-wrap state when a write fills the last column, and it drops an
 * SGR sequence that arrives in that state. A full-width styled line therefore leaves its background
 * active at the right margin, and the next erase-in-line (ESC[2K) paints the whole row with it.
 *
 * The terminal below models exactly that, and only that: it tracks the column from the text it is
 * given, drops an SGR sequence that arrives at the right margin, and records the background that is
 * still active there. The assertion is on that record, not on an estimate of any picture, so the test
 * fails whenever a line reaches the margin with a background still set.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const GREEN = "\x1b[48;2;37;65;49m";
const RESET = "\x1b[0m";

/** A terminal that behaves as Rex Beta does at the right margin: it drops the SGR that lands there. */
class RexTerminal extends VirtualTerminal {
	private column = 0;
	private atMargin = false;
	/** The background the line had when it last reached the right margin; "default" when it cleared it in time. */
	backgroundAtMargin = "default";
	/** The background in effect now, as the sequences that were not dropped set it. */
	private background = "default";
	/** Every SGR the terminal dropped, in order. */
	readonly dropped: string[] = [];

	override write(data: string): void {
		for (const token of data.match(/\x1b\[[0-9;?]*[A-Za-z]|\x1b.|[^\x1b]+/g) ?? []) {
			if (!token.startsWith("\x1b")) {
				this.column += visibleWidth(token);
				if (this.column >= this.columns && !this.atMargin) {
					// What the line leaves active exactly when it fills the last column.
					this.backgroundAtMargin = this.background;
				}
				if (this.column >= this.columns) this.atMargin = true;
				super.write(token);
				continue;
			}
			if (token.endsWith("m")) {
				// Rex drops it, so the background it would have set never takes effect.
				if (this.atMargin) {
					this.dropped.push(token);
					continue;
				}
				this.applySgr(token);
				super.write(token);
				continue;
			}
			// Repositioning and erasing do not leave the pending-wrap state (measured in Rex: a
			// cursor-left between the write and the reset still loses the reset).
			if (token.endsWith("J")) this.atMargin = false;
			if (token.endsWith("H") || token.endsWith("f")) {
				this.atMargin = false;
				this.column = 0;
			}
			super.write(token);
		}
	}

	private applySgr(sequence: string): void {
		const params = sequence.slice(2, -1).split(";").filter(Boolean).map(Number);
		for (let index = 0; index < params.length; index++) {
			const code = params[index]!;
			if (code === 0 || code === 49) this.background = "default";
			else if (code === 48) this.background = params.slice(index + 1, index + 5).join(";");
			else if (code >= 40 && code <= 47) this.background = String(code);
			else if (code >= 100 && code <= 107) this.background = String(code);
		}
	}
}

/** The first visible row of the virtual terminal's buffer. */
function bufferLine(terminal: RexTerminal) {
	const xterm = (terminal as unknown as { xterm: { buffer: { active: { viewportY: number; getLine(row: number): unknown } } } }).xterm;
	const line = xterm.buffer.active.getLine(xterm.buffer.active.viewportY) as
		| { getCell(column: number): { isBgDefault(): boolean; getBgColor(): number } | undefined }
		| undefined;
	assert.ok(line, "the virtual terminal has a first row");
	return line;
}

/** Renders one full-screen frame whose first line is `line`, through the real alt-screen renderer. */
async function render(width: number, line: string) {
	const terminal = new RexTerminal(width, 4);
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => [line], invalidate() {} });
	tui.start();
	await terminal.waitForRender();
	tui.stop();
	return terminal;
}

describe("Rex drops the SGR that lands on the right margin", () => {
	it("does not leave a background active at the margin on a full-width styled line", async () => {
		// A styled line that fills the width, as a padded tool-result line does.
		const terminal = await render(20, `${GREEN}${" ".repeat(20)}`);

		// The renderer must clear the background before the last cell, so that the sequence which
		// Rex drops is not the one that would have cleared it.
		assert.strictEqual(
			terminal.backgroundAtMargin,
			"default",
			"a full-width line must not arrive at the right margin with a background still set; " +
				`Rex drops ${terminal.dropped.length} sequence(s) there, and the next erase-in-line paints the row with it`,
		);
	});

	it("keeps the background of the styled cells themselves", async () => {
		// The fix must reset only the final cell; the line's own background must survive on every other cell.
		const terminal = await render(20, `${GREEN}${" ".repeat(20)}`);
		const line = bufferLine(terminal);
		const background = (column: number) => {
			const cell = line.getCell(column);
			assert.ok(cell, `missing cell at column ${column}`);
			return cell.isBgDefault() ? "default" : String(cell.getBgColor());
		};

		assert.notStrictEqual(background(0), "default", "the line's own cells keep their background");
		assert.notStrictEqual(background(18), "default", "the background holds until the final cell");
		assert.strictEqual(background(19), "default", "the final cell is written on the default background");
	});

	it("drops a sequence at the margin and keeps one that stops short of it", () => {
		// A unit test of the modelled terminal, not of Pi: it fixes what "Rex's defect" means here, so the
		// assertion above is about the margin and nothing else.
		const short = new RexTerminal(20, 2);
		short.write(`${GREEN}${" ".repeat(19)}${RESET}`);
		assert.deepStrictEqual(short.dropped, [], "a line short of the margin loses no sequence");

		const flood = new RexTerminal(20, 2);
		flood.write(`${GREEN}${" ".repeat(20)}${RESET}`);
		assert.deepStrictEqual(flood.dropped, [RESET], "a line that fills the margin loses the reset");
	});

	it("loses the reset sequence itself, which is the observable defect", async () => {
		const terminal = await render(20, `${GREEN}${" ".repeat(20)}`);

		assert.ok(
			terminal.dropped.includes(RESET),
			"Rex drops the reset that Pi appends after a full-width line",
		);
	});
});
