// Explicit unsigned release authorization continues while no trusted Windows
// code-signing certificate is configured in the production release environment.
// Only v3.0.12 omits managed cloud translation.
module.exports = (version) => ({
  unsigned: version === "3.0.12" || version === "3.0.13" || version === "3.0.14",
  offlineTranslationOnly: version === "3.0.12",
});
