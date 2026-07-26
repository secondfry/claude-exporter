// eslint-plugin-tsconfig-paths ships as plain CommonJS with no bundled types.
// It exposes exactly the shape ESLint's flat config expects from a plugin, so
// declaring that shape here is enough — and keeps the config free of the type
// assertion the project bans.
declare module 'eslint-plugin-tsconfig-paths' {
  import type { Rule } from 'eslint';

  const plugin: { rules: Record<string, Rule.RuleModule> };

  export default plugin;
}
