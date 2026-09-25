export default {
  extends: ["stylelint-config-standard", "stylelint-config-tailwindcss"],
  rules: {
    // --spacing-boxShadowX etc. are neobrutalism registry tokens;
    // Tailwind v4 derives utilities (translate-x-boxShadowX) from these exact names.
    "custom-property-pattern": null,
  },
};
