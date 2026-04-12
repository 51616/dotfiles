import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleWidth } from '../node_modules/@mariozechner/pi-tui/dist/index.js';
import { buildPaletteCommands, CommandPaletteOverlay } from '../command-palette/index.ts';

const BG_START = '\u001b[41m';
const BG_END = '\u001b[0m';

const theme = {
  fg(_name, text) {
    return text;
  },
  bg(_name, text) {
    return `${BG_START}${text}${BG_END}`;
  },
  bold(text) {
    return text;
  },
};

function createOverlay(tui = { requestRender() {} }) {
  return new CommandPaletteOverlay(
    tui,
    theme,
    buildPaletteCommands([]),
    '',
    () => {},
  );
}

function getSelectedLine(renderedLines) {
  const selected = renderedLines.find((line) => line.includes(BG_START));
  assert.ok(selected, 'expected a selected command row');
  return selected;
}

function getHighlightedContentWidth(renderedLine) {
  const start = renderedLine.indexOf(BG_START);
  const end = renderedLine.lastIndexOf(BG_END);
  assert.notStrictEqual(start, -1, 'expected selected row to contain highlight start');
  assert.notStrictEqual(end, -1, 'expected selected row to contain highlight end');
  const highlighted = renderedLine.slice(start + BG_START.length, end);
  return visibleWidth(highlighted);
}

describe('CommandPaletteOverlay', () => {
  it('never renders wider than the requested width on narrow terminals', () => {
    const overlay = createOverlay();

    for (const width of [38, 40, 42, 44]) {
      const maxWidth = Math.max(...overlay.render(width).map((line) => visibleWidth(line)));
      assert.ok(
        maxWidth <= width,
        `expected overlay to fit width ${width}, got ${maxWidth}`,
      );
    }
  });

  it('keeps the selected row highlight padded to the full inner width while navigating', () => {
    const overlay = createOverlay();
    const width = 80;
    const expectedHighlightedWidth = width - 4;

    for (let step = 0; step < 12; step += 1) {
      const selectedLine = getSelectedLine(overlay.render(width));
      assert.strictEqual(
        getHighlightedContentWidth(selectedLine),
        expectedHighlightedWidth,
        `expected full-width highlight at step ${step}: ${selectedLine}`,
      );
      overlay.handleInput('\u001b[B');
    }
  });

  it('keeps overlay geometry stable through the last viewport of results', () => {
    const width = 80;
    const expectedVisibleWidth = width;
    const dynamicCommands = Array.from({ length: 43 }, (_, index) => ({
      name: `cmd-${String(index + 1).padStart(2, '0')}`,
      description: `command ${index + 1}`,
      source: 'extension',
      sourceInfo: {
        path: `/tmp/cmd-${index + 1}.ts`,
        source: 'file',
        scope: 'project',
        origin: 'top-level',
      },
    }));
    const overlay = new CommandPaletteOverlay(
      { requestRender() {} },
      theme,
      buildPaletteCommands(dynamicCommands),
      '',
      () => {},
    );

    for (let step = 0; step < 59; step += 1) {
      overlay.handleInput('\u001b[B');
    }

    const snapshots = [];
    for (let step = 59; step <= 62; step += 1) {
      const rendered = overlay.render(width);
      snapshots.push({
        step,
        lines: rendered.length,
        topWidth: visibleWidth(rendered[0]),
        bottomWidth: visibleWidth(rendered.at(-1)),
        footer: rendered.at(-2),
      });
      overlay.handleInput('\u001b[B');
    }

    for (const snapshot of snapshots) {
      assert.strictEqual(snapshot.lines, 17, `expected fixed overlay height at step ${snapshot.step}`);
      assert.strictEqual(snapshot.topWidth, expectedVisibleWidth, `expected stable top border at step ${snapshot.step}`);
      assert.strictEqual(snapshot.bottomWidth, expectedVisibleWidth, `expected stable bottom border at step ${snapshot.step}`);
      assert.match(snapshot.footer, /Showing\s+56-63 of\s+63/, `expected fixed last viewport footer at step ${snapshot.step}`);
    }
  });
});
