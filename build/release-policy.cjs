// Explicit unsigned release authorization continues for the cloud restoration.
// Only v3.0.12 omits managed cloud translation.
module.exports = (version) => ({
  unsigned: version === "3.0.12" || version === "3.0.13",
  offlineTranslationOnly: version === "3.0.12",
});
