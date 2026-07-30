import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    rules: {
      // The server shuttles arbitrary FIC API JSON; typing it fully buys nothing here.
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
