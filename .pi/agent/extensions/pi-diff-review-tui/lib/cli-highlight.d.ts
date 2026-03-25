declare module "cli-highlight" {
  export type CliHighlightTheme = Record<string, (s: string) => string>;

  export function highlight(
    code: string,
    options?: {
      language?: string;
      ignoreIllegals?: boolean;
      theme?: CliHighlightTheme;
    },
  ): string;

  export function supportsLanguage(language: string): boolean;
}
