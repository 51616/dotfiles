import { Key, matchesKey, type Component, type Focusable } from "@mariozechner/pi-tui";

export class SimpleOverlay implements Component, Focusable {
  focused = false;
  private readonly onClose: () => void;
  private readonly renderFn: (width: number) => string[];
  private readonly handleFn?: (data: string) => void;

  constructor({
    onClose,
    render,
    handleInput,
  }: {
    onClose: () => void;
    render: (width: number) => string[];
    handleInput?: (data: string) => void;
  }) {
    this.onClose = onClose;
    this.renderFn = render;
    this.handleFn = handleInput;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }
    this.handleFn?.(data);
  }

  render(width: number): string[] {
    return this.renderFn(width);
  }

  invalidate(): void {}
}
