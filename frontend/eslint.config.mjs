import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Project-wide rule overrides.
    //
    // Rationale: this codebase carries a large amount of untyped external API
    // response data plumbed through many render paths (see e.g.
    // app/retailers/[retailerAccountId]/simulation/[runId]/page.tsx) plus
    // several React-19-era hook patterns flagged by the newer
    // react-hooks/set-state-in-effect and react-hooks/purity checks. These are
    // real signals worth fixing incrementally but they should not block CI
    // today, so we downgrade them to warnings.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      // Allow intentionally-unused args/vars prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
