// Explicit release decision: v3.0.12 ships unsigned and uses offline translation.
// Future versions return to the signed, managed-provider release requirements.
module.exports = (version) => ({
  unsigned: version === "3.0.12",
  offlineTranslationOnly: version === "3.0.12",
});
