/* NGR AssetPilot V2.25 module: state-dom.js */
let projects;
let activeProjectId;
let schemes;
let rules;
let aiSettings;
let translationSettings;
let prefixLibrary;
let currentWorkProjectName;
let assets;
let namingSessions;
let activeNamingSessionId;
let detectionProfiles;
let activeDetectionProfileId;
let detectionAssets;
let selectedId;
let referenceFile;
let referencePreviewUrl;
let namingController;
let stopRequested;
let showProblemOnly;
let showDetectionProblemOnly;
let showDetectionWarningOnly;
let toastTimer;
let activeLexiconCategory;
let listDisplayMode;
let listSortMode;
let albumSettings;
let albumPage;
let albumEditorOpen;
let knowledgeCacheKey;
let knowledgeCacheValue;
let assetRenderLimit;
let detectionRenderLimit;
let guideStepIndex;
let tutorialSlideIndex;
let baiduTextCache;
let meaningCache;
let pendingMeaningNames;
let translatorDragState;

function bootstrapState() {
  prefixLibrary = loadPrefixLibrary();
  currentWorkProjectName = "";
  projects = loadProjects();
  activeProjectId = loadActiveProjectId(projects);
  schemes = getActiveProject().schemes;
  rules = normalizeLoadedRules({ ...defaultRules, ...getProjectActiveScheme(getActiveProject()) });
  aiSettings = loadAiSettings();
  translationSettings = loadTranslationSettings();
  assets = [];
  namingSessions = [];
  activeNamingSessionId = null;
  detectionProfiles = loadDetectionProfiles();
  activeDetectionProfileId = loadActiveDetectionProfileId(detectionProfiles);
  detectionAssets = [];
  selectedId = null;
  referenceFile = null;
  referencePreviewUrl = "";
  namingController = null;
  stopRequested = false;
  showProblemOnly = false;
  showDetectionProblemOnly = false;
  showDetectionWarningOnly = false;
  toastTimer = null;
  activeLexiconCategory = "状态";
  listDisplayMode = loadListDisplayMode();
  listSortMode = loadListSortMode();
  albumSettings = normalizeAlbumSettings();
  albumPage = 1;
  albumEditorOpen = false;
  knowledgeCacheKey = "";
  knowledgeCacheValue = null;
  assetRenderLimit = ASSET_RENDER_BATCH_SIZE;
  detectionRenderLimit = DETECTION_RENDER_BATCH_SIZE;
  guideStepIndex = 0;
  tutorialSlideIndex = 0;
  baiduTextCache = new Map();
  meaningCache = loadMeaningCache();
  pendingMeaningNames = new Set();
  translatorDragState = null;
}

const els = {
  backButton: document.querySelector("#backButton"),
  pageHint: document.querySelector("#pageHint"),
  views: {
    home: document.querySelector("#homeView"),
    rules: document.querySelector("#rulesView"),
    work: document.querySelector("#workView"),
    detect: document.querySelector("#detectView"),
    detectionSettings: document.querySelector("#detectionSettingsView"),
    localImageSearch: document.querySelector("#localImageSearchView"),
    generalSettings: document.querySelector("#generalSettingsView"),
    localImageSearchSettings: document.querySelector("#localImageSearchSettingsView"),
  },
  rulesEntry: document.querySelector("#rulesEntry"),
  updateAvailableButton: document.querySelector("#updateAvailableButton"),
  tutorialEntry: document.querySelector("#tutorialEntry"),
  guideEntry: document.querySelector("#guideEntry"),
  workEntry: document.querySelector("#workEntry"),
  detectEntry: document.querySelector("#detectEntry"),
  localImageSearchEntry: document.querySelector("#localImageSearchEntry"),
  projectSelect: document.querySelector("#projectSelect"),
  projectConfigName: document.querySelector("#projectConfigName"),
  projectConfigDescription: document.querySelector("#projectConfigDescription"),
  schemeSelect: document.querySelector("#schemeSelect"),
  workSchemeSelect: document.querySelector("#workSchemeSelect"),
  schemeName: document.querySelector("#schemeName"),
  basePrefix: document.querySelector("#basePrefix"),
  prefixPreset: document.querySelector("#prefixPreset"),
  prefixLibraryOverlay: document.querySelector("#prefixLibraryOverlay"),
  prefixLibraryList: document.querySelector("#prefixLibraryList"),
  prefixLibraryNewValue: document.querySelector("#prefixLibraryNewValue"),
  prefixLibraryAdd: document.querySelector("#prefixLibraryAdd"),
  prefixLibraryClose: document.querySelector("#prefixLibraryClose"),
  projectName: document.querySelector("#projectName"),
  workBasePrefix: document.querySelector("#workBasePrefix"),
  workProjectName: document.querySelector("#workProjectName"),
  workViewName: document.querySelector("#workViewName"),
  separator: document.querySelector("#separator"),
  tags: document.querySelector("#tags"),
  pageTerms: document.querySelector("#pageTerms"),
  componentTerms: document.querySelector("#componentTerms"),
  stateTerms: document.querySelector("#stateTerms"),
  filenameRules: document.querySelector("#filenameRules"),
  contextDocs: document.querySelector("#contextDocs"),
  aiPromptText: document.querySelector("#aiPromptText"),
  exportPromptText: document.querySelector("#exportPromptText"),
  importPromptText: document.querySelector("#importPromptText"),
  aiProvider: document.querySelector("#aiProvider"),
  aiApiFormat: document.querySelector("#aiApiFormat"),
  aiBaseUrl: document.querySelector("#aiBaseUrl"),
  openaiApiKey: document.querySelector("#openaiApiKey"),
  openaiModel: document.querySelector("#openaiModel"),
  aiProviderNote: document.querySelector("#aiProviderNote"),
  saveAiSettings: document.querySelector("#saveAiSettings"),
  testAiSettings: document.querySelector("#testAiSettings"),
  exportAiSettings: document.querySelector("#exportAiSettings"),
  importAiSettings: document.querySelector("#importAiSettings"),
  exportSchemeTemplate: document.querySelector("#exportSchemeTemplate"),
  importSchemeTemplate: document.querySelector("#importSchemeTemplate"),
  prefixPreview: document.querySelector("#prefixPreview"),
  saveRules: document.querySelector("#saveRules"),
  saveAsScheme: document.querySelector("#saveAsScheme"),
  deleteScheme: document.querySelector("#deleteScheme"),
  newProject: document.querySelector("#newProject"),
  saveProject: document.querySelector("#saveProject"),
  deleteProject: document.querySelector("#deleteProject"),
  resetRules: document.querySelector("#resetRules"),
  activeRuleText: document.querySelector("#activeRuleText"),
  uploadDropZone: document.querySelector("#uploadDropZone"),
  uploadSourceMenu: document.querySelector("#uploadSourceMenu"),
  folderInput: document.querySelector("#folderInput"),
  singleInput: document.querySelector("#singleInput"),
  referenceInput: document.querySelector("#referenceInput"),
  referencePreviewWrap: document.querySelector("#referencePreviewWrap"),
  referencePreview: document.querySelector("#referencePreview"),
  referenceName: document.querySelector("#referenceName"),
  namingSessionList: document.querySelector("#namingSessionList"),
  newNamingSession: document.querySelector("#newNamingSession"),
  saveNamingWorkspace: document.querySelector("#saveNamingWorkspace"),
  namingSaveStatus: document.querySelector("#namingSaveStatus"),
  selectVisibleAssets: document.querySelector("#selectVisibleAssets"),
  selectedAssetCount: document.querySelector("#selectedAssetCount"),
  assetList: document.querySelector("#assetList"),
  fileCount: document.querySelector("#fileCount"),
  namingModeSelect: document.querySelector("#namingModeSelect"),
  runSelectedNaming: document.querySelector("#runSelectedNaming"),
  stopNaming: document.querySelector("#stopNaming"),
  exportModeSelect: document.querySelector("#exportModeSelect"),
  exportFiles: document.querySelector("#exportFiles"),
  exportMenu: document.querySelector("#exportMenu"),
  batchOperationMode: document.querySelector("#batchOperationMode"),
  batchSuffix: document.querySelector("#batchSuffix"),
  batchSequenceStart: document.querySelector("#batchSequenceStart"),
  applyBatchOperation: document.querySelector("#applyBatchOperation"),
  listDisplayModeSelect: document.querySelector("#listDisplayModeSelect"),
  listSortModeSelect: document.querySelector("#listSortModeSelect"),
  albumGridSettings: document.querySelector("#albumGridSettings"),
  albumColumns: document.querySelector("#albumColumns"),
  albumRows: document.querySelector("#albumRows"),
  albumColumnGap: document.querySelector("#albumColumnGap"),
  albumRowGap: document.querySelector("#albumRowGap"),
  workspace: document.querySelector("#workspace"),
  albumEditorPanel: document.querySelector("#albumEditorPanel"),
  problemFilter: document.querySelector("#problemFilter"),
  removeSelected: document.querySelector("#removeSelected"),
  detectionProfileSelect: document.querySelector("#detectionProfileSelect"),
  detectionModeSelect: document.querySelector("#detectionModeSelect"),
  duplicateSensitivitySelect: document.querySelector("#duplicateSensitivitySelect"),
  detectionSettingsEntry: document.querySelector("#detectionSettingsEntry"),
  detectionSettingsProfileSelect: document.querySelector("#detectionSettingsProfileSelect"),
  detectionProfileName: document.querySelector("#detectionProfileName"),
  detectionProfileMode: document.querySelector("#detectionProfileMode"),
  duplicateSensitivityProfile: document.querySelector("#duplicateSensitivityProfile"),
  detectionMaxSide: document.querySelector("#detectionMaxSide"),
  detectionBgWidth: document.querySelector("#detectionBgWidth"),
  detectionBgHeight: document.querySelector("#detectionBgHeight"),
  detectionLargeThreshold: document.querySelector("#detectionLargeThreshold"),
  detectionLargeMultiple: document.querySelector("#detectionLargeMultiple"),
  detectionAtlasMultiple: document.querySelector("#detectionAtlasMultiple"),
  saveDetectionProfile: document.querySelector("#saveDetectionProfile"),
  newDetectionProfile: document.querySelector("#newDetectionProfile"),
  deleteDetectionProfile: document.querySelector("#deleteDetectionProfile"),
  backToDetection: document.querySelector("#backToDetection"),
  detectionDropZone: document.querySelector("#detectionDropZone"),
  detectionFolderInput: document.querySelector("#detectionFolderInput"),
  detectionSingleInput: document.querySelector("#detectionSingleInput"),
  detectionRulesToggle: document.querySelector("#detectionRulesToggle"),
  detectionRulesPanel: document.querySelector("#detectionRulesPanel"),
  detectionProblemFilter: document.querySelector("#detectionProblemFilter"),
  detectionWarningFilter: document.querySelector("#detectionWarningFilter"),
  clearDetectionAssets: document.querySelector("#clearDetectionAssets"),
  detectionCount: document.querySelector("#detectionCount"),
  detectionList: document.querySelector("#detectionList"),
  translatorPanel: document.querySelector("#translatorPanel"),
  translatorToggle: document.querySelector("#translatorToggle"),
  translatorDragHandle: document.querySelector("#translatorDragHandle"),
  translatorClose: document.querySelector("#translatorClose"),
  translatorSettingsToggle: document.querySelector("#translatorSettingsToggle"),
  translatorSettings: document.querySelector("#translatorSettings"),
  translatorProvider: document.querySelector("#translatorProvider"),
  translatorProviderGroups: document.querySelectorAll("[data-provider-group]"),
  baiduTranslateAppId: document.querySelector("#baiduTranslateAppId"),
  baiduTranslateSecret: document.querySelector("#baiduTranslateSecret"),
  baiduTranslateEndpoint: document.querySelector("#baiduTranslateEndpoint"),
  textTranslateBaseUrl: document.querySelector("#textTranslateBaseUrl"),
  textTranslateApiKey: document.querySelector("#textTranslateApiKey"),
  textTranslateModel: document.querySelector("#textTranslateModel"),
  saveTranslatorSettings: document.querySelector("#saveTranslatorSettings"),
  testTranslatorSettings: document.querySelector("#testTranslatorSettings"),
  translatorInput: document.querySelector("#translatorInput"),
  translatorToName: document.querySelector("#translatorToName"),
  translatorApplyName: document.querySelector("#translatorApplyName"),
  translatorExplain: document.querySelector("#translatorExplain"),
  translatorOutput: document.querySelector("#translatorOutput"),
  guideOverlay: document.querySelector("#guideOverlay"),
  guideHighlight: document.querySelector("#guideHighlight"),
  guidePopover: document.querySelector("#guidePopover"),
  guideStepCount: document.querySelector("#guideStepCount"),
  guideTitle: document.querySelector("#guideTitle"),
  guideText: document.querySelector("#guideText"),
  guidePrev: document.querySelector("#guidePrev"),
  guideNext: document.querySelector("#guideNext"),
  guideClose: document.querySelector("#guideClose"),
  tutorialOverlay: document.querySelector("#tutorialOverlay"),
  tutorialStepCount: document.querySelector("#tutorialStepCount"),
  tutorialImage: document.querySelector("#tutorialImage"),
  tutorialPrev: document.querySelector("#tutorialPrev"),
  tutorialNext: document.querySelector("#tutorialNext"),
  tutorialClose: document.querySelector("#tutorialClose"),
  workspaceMigrationCard: document.querySelector("#workspaceMigrationCard"),
  workspaceMigrationIntro: document.querySelector("#workspaceMigrationIntro"),
  exportWorkspaceBackup: document.querySelector("#exportWorkspaceBackup"),
  importWorkspaceBackup: document.querySelector("#importWorkspaceBackup"),
  workspaceBackupInput: document.querySelector("#workspaceBackupInput"),
  includeBackupSecrets: document.querySelector("#includeBackupSecrets"),
  workspaceBackupPassword: document.querySelector("#workspaceBackupPassword"),
  workspaceMigrationStatus: document.querySelector("#workspaceMigrationStatus"),
  generalSettingsMigrationSlot: document.querySelector("#generalSettingsMigrationSlot"),
  localSearchSettingsSlot: document.querySelector("#localSearchSettingsSlot"),
  localSearchSidebar: document.querySelector(".local-search-sidebar"),
  currentAppVersion: document.querySelector("#currentAppVersion"),
  manualUpdateStatus: document.querySelector("#manualUpdateStatus"),
  manualUpdateCheck: document.querySelector("#manualUpdateCheck"),
  websiteDownloadLink: document.querySelector("#websiteDownloadLink"),
  historyDownloadLink: document.querySelector("#historyDownloadLink"),
  updateDialogOverlay: document.querySelector("#updateDialogOverlay"),
  updateDialogClose: document.querySelector("#updateDialogClose"),
  updateCurrentVersion: document.querySelector("#updateCurrentVersion"),
  updateLatestVersion: document.querySelector("#updateLatestVersion"),
  updateDownloadSize: document.querySelector("#updateDownloadSize"),
  updateReleaseDate: document.querySelector("#updateReleaseDate"),
  updateReleaseNotes: document.querySelector("#updateReleaseNotes"),
  updateProgressWrap: document.querySelector("#updateProgressWrap"),
  updateProgress: document.querySelector("#updateProgress"),
  updateProgressText: document.querySelector("#updateProgressText"),
  updatePrimaryAction: document.querySelector("#updatePrimaryAction"),
  updateWebsiteAction: document.querySelector("#updateWebsiteAction"),
  toast: document.querySelector("#toast"),
};
