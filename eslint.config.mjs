import tseslint from "typescript-eslint";
export default [{
  files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "no-unused-vars": "off",
    "no-constant-condition": "error",
    "no-debugger": "error"
  }
}];
