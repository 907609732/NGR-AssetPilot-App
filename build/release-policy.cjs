// Only v3.0.12 omits managed cloud translation.
module.exports = (version) => ({
  offlineTranslationOnly: version === "3.0.12",
});
