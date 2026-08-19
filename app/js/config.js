/* NGR AssetPilot V2.26 module: config.js */
const APP_VERSION = "V3.0.0";
const APP_VERSION_KEY = "ngr-ai-autoname-app-version";
const STORAGE_KEY = "ngr-ai-autoname-rules";
const SCHEME_KEY = "ngr-ai-autoname-rule-schemes";
const PROJECTS_KEY = "ngr-ai-autoname-projects";
const ACTIVE_PROJECT_KEY = "ngr-ai-autoname-active-project";
const AI_SETTINGS_KEY = "ngr-ai-autoname-ai-settings";
const TRANSLATION_SETTINGS_KEY = "ngr-ai-autoname-translation-settings";
const DETECTION_PROFILES_KEY = "ngr-ai-autoname-detection-profiles";
const ACTIVE_DETECTION_PROFILE_KEY = "ngr-ai-autoname-active-detection-profile";
const LIST_DISPLAY_MODE_KEY = "ngr-ai-autoname-list-display-mode";
const LIST_SORT_MODE_KEY = "ngr-ai-autoname-list-sort-mode";
const PREFIX_LIBRARY_KEY = "ngr-assetpilot-prefix-library-v1";
const NAMING_WORKSPACE_DB_NAME = "ngr-assetpilot-naming-workspace";
const NAMING_WORKSPACE_DB_VERSION = 1;
const NAMING_WORKSPACE_KEY = "default";
const NAMING_WORKSPACE_SAVE_DELAY = 700;
const DEFAULT_ALBUM_SETTINGS = Object.freeze({ columns: 4, rows: 6, columnGap: 112, rowGap: 46 });
const MEANING_CACHE_KEY = "ngr-ai-autoname-meaning-cache";
const APP_STORAGE_KEYS = [
  STORAGE_KEY,
  SCHEME_KEY,
  PROJECTS_KEY,
  ACTIVE_PROJECT_KEY,
  AI_SETTINGS_KEY,
  TRANSLATION_SETTINGS_KEY,
  DETECTION_PROFILES_KEY,
  ACTIVE_DETECTION_PROFILE_KEY,
  LIST_DISPLAY_MODE_KEY,
  LIST_SORT_MODE_KEY,
  PREFIX_LIBRARY_KEY,
  MEANING_CACHE_KEY,
];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const UPLOAD_PROCESS_BATCH_SIZE = 80;
const UPLOAD_CONCURRENCY = 4;
const ASSET_RENDER_BATCH_SIZE = 120;
const DETECTION_RENDER_BATCH_SIZE = 160;
const MAX_DUPLICATE_SCAN_ASSETS = 600;
const BAIDU_NAMING_CONCURRENCY = 3;
const NGR_TRAINING_VERSION = 7;
const YYSLS_TRAINING_VERSION = 1;
const FORBIDDEN_NAMING_TERMS = ["module", "modules"];
const lexiconCategories = [
  { title: "状态", terms: ["Normal", "Nml", "Default", "Hover", "Pressed", "Down", "Active", "Selected", "Sel", "Unselected", "UnSel", "Disabled", "Forbidden", "Lock", "Unlock", "Open", "Close", "On", "Off", "Check", "Checked", "Focus", "New", "Hot"] },
  { title: "类型", terms: ["BG", "MainBG", "PanelBG", "IconBG", "Button", "Btn", "Go", "Icon", "Line", "Divider", "Bar", "ProgressBar", "Frame", "Mask", "Card", "Tab", "Panel", "Popup", "Dialog", "Window", "Item", "Slot", "Cell", "Title", "Text", "Number"] },
  { title: "装饰", terms: ["Light", "Shadow", "Pattern", "Ornament", "Deco", "Glow", "Spark", "Ribbon", "Border", "Corner", "Circle", "Bubble", "Point", "Arrow", "Star", "Dot", "Wave", "Cloud", "Flame", "Halo"] },
  { title: "内容", terms: ["Illustration", "Character", "Weapon", "Rewards", "Gift", "Badge", "Logo", "Avatar", "Portrait", "Shop", "Task", "Quest", "Map", "Skill", "Rank", "Record", "Journal", "Mail", "Bag", "Coin", "Gold", "Diamond"] },
  { title: "布局", terms: ["Header", "Footer", "Content", "List", "Grid", "Menu", "Nav", "Sidebar", "Toolbar", "Tips", "Toast", "Notice", "Tag", "Label", "Input", "Slider", "Switch"] },
  { title: "方向", terms: ["Left", "Right", "Top", "Bottom", "Center", "Middle", "Front", "Back", "Corner", "TopLeft", "TopRight", "BottomLeft", "BottomRight", "Horizontal", "Vertical"] },
  { title: "颜色", terms: ["Red", "Blue", "Yellow", "Green", "Black", "White", "Gold", "Purple", "Orange", "Gray", "Dark", "Light", "Cyan", "Pink"] },
];

const defaultRules = {
  schemeName: "默认方案",
  basePrefix: "T_UI",
  projectName: "工程名",
  viewName: "",
  separator: "_",
  tags: "BG, Button, Hover, Normal, Icon, Item, Frame, Mask, Panel, Title, Line, ProgressBar, Selected, Disabled",
  pageTerms: "Home\nLogin\nProfile\nSettings",
  componentTerms: "BG\nMainBG\nPanelBG\nIconBG\nButton\nBtn\nGo\nIcon\nBanner\nNav\nMenu\nItem\nSlot\nCell\nFrame\nMask\nPanel\nPopup\nDialog\nWindow\nCard\nLine\nDivider\nBar\nProgressBar\nTitle\nText\nNumber\nArrow\nPoint\nBadge\nLogo\nAvatar\nPortrait\nRewards\nGift\nCoin\nGold\nDiamond\nTask\nQuest\nMail\nBag\nShop\nMap\nSkill\nRank\nTips\nToast\nNotice\nTag\nLabel\nInput\nSlider\nSwitch\nOrnament\nDeco",
  stateTerms: "Normal\nNml\nDefault\nHover\nPressed\nDown\nActive\nSelected\nSel\nUnselected\nUnSel\nDisabled\nForbidden\nLock\nUnlock\nOpen\nClose\nOn\nOff\nCheck\nChecked\nFocus\nNew\nHot",
  filenameRules: "首页=Home\n主页=Home\n主界面=Home\n登录=Login\n登陆=Login\n个人中心=Profile\n我的=Profile\n设置=Settings\n背景=BG\n底图=BG\n底=BG\n背景图=BG\n主背景=MainBG\n面板背景=PanelBG\n图标底=IconBG\n前往按钮=Go_Button\n前往=Go\n按钮=Button\n按键=Button\n图标=Icon\n导航=Nav\n菜单=Menu\n横幅=Banner\n模块=Item\n条目=Item\n格子=Slot\n槽位=Slot\n单元格=Cell\n奖励=Rewards\n礼物=Gift\n金币=Gold\n货币=Coin\n钻石=Diamond\n任务=Task\n任务栏=Task\n邮件=Mail\n背包=Bag\n商店=Shop\n地图=Map\n技能=Skill\n排行=Rank\n排名=Rank\n提示=Tips\n公告=Notice\n标签=Tag\n输入框=Input\n滑条=Slider\n开关=Switch\n弹窗=Popup\n弹框=Popup\n对话框=Dialog\n窗口=Window\n面板=Panel\n卡带=Card\n卡片=Card\n卡=Card\n边框=Frame\n框=Frame\n遮罩=Mask\n线=Line\n线条=Line\n分割线=Divider\n进度=ProgressBar\n进度条=ProgressBar\n光效=Light\n光=Light\n阴影=Shadow\n纹理=Pattern\n装饰品=Ornament\n装饰=Deco\n角标=Badge\n头像=Avatar\n头像框=Avatar_Frame\n立绘=Portrait\n常态=Normal\n普通=Normal\n默认=Normal\n悬浮=Hover\n按下=Pressed\n按压=Pressed\n选中=Selected\n未选中=Unselected\n点击=Active\n激活=Active\n禁用=Disabled\n不可用=Disabled\n锁定=Lock\n解锁=Unlock\n打开=Open\n关闭=Close\n开启=On\n勾选=Checked\n焦点=Focus\n新增=New\n热门=Hot\n左上角=TopLeft\n右上角=TopRight\n左下角=BottomLeft\n右下角=BottomRight\n左上=TopLeft\n右上=TopRight\n左下=BottomLeft\n右下=BottomRight\n左=Left\n右=Right\n上=Top\n下=Bottom\n中=Center\n横向=Horizontal\n竖向=Vertical\n红=Red\n蓝=Blue\n黄=Yellow\n绿=Green\n黑=Black\n白=White\n金=Gold\n紫=Purple\n橙=Orange\n灰=Gray\n亮=Light\n暗=Dark\nbg=BG\nbackground=BG\nBackground=BG\nReward=Rewards\nRewards=Rewards\nbtn=Button\nbutton=Button\nicon=Icon\nhover=Hover\nactive=Active\ndisabled=Disabled\nhome=Home\nlogin=Login\nuser=Profile",
  contextDocs: "",
  aiPromptText: "",
};

const yyslsTrainingKnowledge = {
  tags: "bg, btn, icon, line, frame, mask, tab, sel, nml, hover, ban, pinyin, lower_case",
  pageTerms: [
    "login", "loading", "face", "career", "huijuan", "task", "home", "mainpage", "nielian", "yuxue", "shequ", "yulan",
    "kaifeng", "qiyu", "fenzhi", "coures", "courses", "dialoge", "bm", "vx", "com", "map", "banner", "menpai",
    "shop", "world", "hud", "skill", "baiye", "wulinlu", "modular", "model", "waiguan", "activity", "collection",
    "player", "talk", "billboard", "buff", "equip", "bangpai", "huizhang", "xinhu", "sundries", "wuxue", "chengjiu",
    "bag", "qishu", "shusheng", "guide", "tianfu", "entity", "hanghui", "pvp", "photo", "setting", "yezixi",
    "xinfa", "building", "reward", "debate", "hangdang", "tyro", "toushi", "fuben", "huisu", "xiaofei", "weather"
  ].join("\n"),
  componentTerms: [
    "bg", "btn", "icon", "line", "frame", "mask", "tab", "item", "title", "pop", "bar", "pro", "slider", "floor",
    "pic", "head", "body", "circle", "light", "shadow", "glow", "dian", "diban", "diwen", "huawen", "zhuangshi",
    "jianbian", "tishi", "erweima", "lunpan", "jindu", "guide", "name", "photo", "share", "voice", "play", "pause",
    "emotion", "ui", "96", "144", "v3", "v2", "01", "02", "03", "04", "head", "qishu", "baiye", "npc", "tips",
    "lizi", "loop", "lod", "kfc", "wave", "decorate", "text", "keyboard", "base", "page", "mobile", "collection",
    "thumbnail", "png", "girl", "black", "white", "gold", "blue", "arrow", "card", "point", "tip", "flow",
    "par", "deco", "flower", "team", "sound", "portrait", "clouds", "fire", "wood"
  ].join("\n"),
  stateTerms: [
    "nml", "sel", "hover", "ban", "focus", "dark", "light", "lock", "unlock", "normal", "selected", "disabled",
    "x", "z", "l", "d", "left", "right", "top", "bottom", "long", "big", "small", "pc", "mobile", "zuo", "you"
  ].join("\n"),
  filenameRules: [
    "常态=nml", "默认=nml", "普通=nml", "选中=sel", "选择=sel", "悬浮=hover", "禁用=ban", "不可用=ban", "焦点=focus",
    "按钮=btn", "背景=bg", "底图=bg", "底=bg", "图标=icon", "线=line", "线条=line", "边框=frame", "遮罩=mask", "标签=tab",
    "渐变=jianbian", "花纹=huawen", "装饰=zhuangshi", "底板=diban", "地板=diban", "底纹=diwen", "二维码=erweima",
    "转盘=lunpan", "进度=jindu", "提示=tishi", "预览=yulan", "社区=shequ", "捏脸=nielian", "选择=xuanze", "引导=guide",
    "左边=zuobian", "右边=youbian", "左=left", "右=right", "黑=dark", "白=light", "亮=light", "暗=dark",
    "bg=bg", "BG=bg", "btn=btn", "Btn=btn", "button=btn", "Button=btn", "icon=icon", "Icon=icon", "line=line", "Line=line",
    "frame=frame", "Frame=frame", "mask=mask", "Mask=mask", "normal=nml", "Normal=nml", "nml=nml", "NML=nml",
    "select=sel", "selected=sel", "Selected=sel", "sel=sel", "hover=hover", "Hover=hover", "disabled=ban", "Disabled=ban",
    "ban=ban", "focus=focus", "dark=dark", "light=light"
  ].join("\n"),
  contextDocs: [
    "燕云十六声 / yysls 历史切图命名习惯：已完整扫描 Resources/png 目录 28080 张 PNG，其中 27025 个文件名为全小写，26315 个使用下划线分段；命名以小写 snake_case 为主，不使用 PascalCase。",
    "命名结构通常为：页面或系统前缀_功能语义_组件类型_状态，例如 login_btn_nml、loading_secrecy_btn_sel、face_create_btn_right_bg_zhu_nml。",
    "中英混合但以拼音为主：nielian、jianbian、huawen、zhuangshi、diban、erweima、xuanze、yulan、shequ、lunpan、zuobian、youbian 等可直接作为命名词。",
    "高频页面/系统前缀包括：vx、com、map、home、banner、ui、menpai、shop、icon、head、world、hud、skill、task、baiye、wulinlu、modular、model、face、waiguan、activity、collection、player、talk、equip、wuxue、hanghui。",
    "英文多用短词或缩写：bg、btn、icon、line、frame、mask、tab、item、title、pop、bar、pro、slider、pic、head、circle、light、glow、shadow、guide、mask。",
    "状态词固定倾向：nml=常态，sel=选中，hover=悬浮，ban=禁用，focus=焦点；不要生成 Normal、Selected、Disabled 这类长英文状态词。",
    "最终名称必须保持全小写 snake_case，用下划线连接；如果中文原名包含拼音习惯词，优先保留拼音而不是翻译成长英文。"
  ].join("\n")
};

const builtinSchemes = [
  {
    ...defaultRules,
    schemeName: "NGR图集命名规范",
    projectName: "NGR",
    contextDocs: "该项目由驼峰命名规则首字母大写。命名应优先使用英文 Pascal Case 词组但要支持公认的缩写英文，并用下划线连接，例如 Home_Button_Normal。",
  },
  {
    ...defaultRules,
    schemeName: "yysls命名规范",
    projectName: "yysls",
    tags: yyslsTrainingKnowledge.tags,
    pageTerms: yyslsTrainingKnowledge.pageTerms,
    componentTerms: yyslsTrainingKnowledge.componentTerms,
    stateTerms: yyslsTrainingKnowledge.stateTerms,
    filenameRules: defaultRules.filenameRules + "\n" + yyslsTrainingKnowledge.filenameRules,
    contextDocs: yyslsTrainingKnowledge.contextDocs,
  },
  {
    ...defaultRules,
    schemeName: "更多项目正在持续开发中",
    projectName: "More",
    contextDocs: "占位项目配置。后续可以复制或修改为新的项目命名规范。",
  },
];

const ngrTrainingKnowledge = {
  projectTerms: [
    "Modules", "SkillPanel", "Mall", "RPVPArena", "Keyboard", "Reward", "Toast", "PVPBRMap", "MainHUD", "ActivityChessMiniGame", "Homestead",
    "Plateau", "NewBattle", "Lottery", "MainHUDStatic", "PVPTeam", "Setting", "MallS1", "Team", "MissionHandbook", "Intimacy",
    "PVPMidBattle", "SocialChat", "ActivityVegetableXiaoXiaoLe", "PVPBattleCommon", "QuestGuide", "SceneryRecord", "BattlePass", "PVPBR",
    "FengyunFestival", "CreationBox", "ActivitySanrio", "GuanDan", "S1SeasonInterface", "ActivityHonorOfKingsLinkage", "RPVPTourArena",
    "Indicator", "RPVPArenaBroadcast", "MissionCalendar", "Gamepad", "VegetableFairySkateboard", "PVPBRSystemBroadcast", "RoleViewing",
    "ImageJumpping", "UserLogin", "Personalization", "Appearance", "TopLog", "Weapon", "Cultivate", "MainRole", "Map", "MusicFestival",
    "RPVPArenaLoading", "RPVPArenaMatch", "Identification", "RPVPPick", "Fishing", "RPVPRankReview", "PVPBRHall", "Battle", "Schools",
    "PVPBag", "RPVPArenaOver", "Skill", "HeroicChronicles", "PVPLobby", "PVPLogin", "NewbieTask", "CreateRole", "ActivityRoleLiBai",
    "Credit", "AchievementCenter", "RPVPWristSeal", "SocialBadge", "BackFlow", "Decompose", "SailNote", "ActivityTips", "DailyCheckIn",
    "ClimbingFestival", "Illustration", "RPVPArenaPrep", "BlindBox", "WristSealSkills", "PVPBRSkillPanel", "MainHUDMenu", "Achievement",
    "PVPBRTopLog", "EquipmentMake", "ActivityCharacterChallenge", "ItemNotice"
  ],
  componentTerms: [
    "BG", "Bg", "Button", "Btn", "Go", "Icon", "Banner", "Nav", "Item", "Line", "Bar", "ProgressBar", "Frame", "Mask", "Light",
    "Pattern", "Tab", "Card", "Item", "Panel", "Container", "Arrow", "Sprite", "Title", "Text", "Txt", "Number", "Num", "Point",
    "Circle", "Bubble", "Logo", "Tag", "Lock", "Unlock", "Popup", "Toast", "Broadcast", "Recommend", "Rewards", "GloryRewards", "Guide",
    "GuideKey", "Key", "Map", "Skill", "SkillBg", "HeadBg", "TitleBg", "MainBg", "IconBg", "AvatarMask", "Progress", "Quality",
    "Settlement", "Ranking", "Challenge", "InvitationNotice", "Airdrop", "ShadowTrial", "Resonance", "DailyFreeGiftPack", "NPC", "Gold",
    "Switch", "UpGrade", "Vegetable", "Badge", "Loading", "PlayerPet", "Task", "Game", "Inscription", "Level", "Box", "Shadow", "Arena",
    "Wheel", "RankReward", "MonthyCard", "Direction", "Pagoda", "DeathEffect", "Empty", "Dispatch", "Party", "Tips", "Middle", "Role",
    "Dungeon", "Ornament", "Deco"
  ].join("\n"),
  stateTerms: [
    "Normal", "Nml", "Hover", "Active", "Selected", "Select", "Sel", "Unselected", "UnSel", "Disabled", "Forbidden", "Lock", "Unlock",
    "Pressed", "Down", "Up", "Open", "Close", "Check", "Pick", "Ban", "Activate", "Default", "Focus", "On", "Off", "Red", "Blue",
    "Yellow", "Black", "White", "Left", "Right", "Top", "Bottom", "Small", "Big"
  ].join("\n"),
  filenameRules: [
    "Icon=Icon", "Bg=BG", "BG=BG", "bg=BG", "Btn=Button", "button=Button", "Line=Line", "Divider=Line", "Bar=Bar",
    "Progress=Progress", "ProgressBar=ProgressBar", "Light=Light", "Mask=Mask", "Frame=Frame", "Pattern=Pattern", "Tab=Tab",
    "Card=Card", "Container=Container", "Arrow=Arrow", "Sprite=Sprite", "Title=Title", "Txt=Text", "Text=Text", "Num=Number",
    "Sel=Selected", "Select=Selected", "Selected=Selected", "UnSel=Unselected", "Nml=Normal", "Normal=Normal", "Hover=Hover",
    "Active=Active", "Disabled=Disabled", "Forbidden=Forbidden", "PressedDwon=PressedDown", "PressedDown=PressedDown", "Check=Check",
    "Pick=Pick", "Ban=Ban", "Lock=Lock", "Unlock=Unlock", "Popup=Popup", "Toast=Toast", "Broadcast=Broadcast", "Recommend=Recommend",
    "Reward=Rewards", "Rewards=Rewards", "GloryReward=GloryRewards", "GloryRewards=GloryRewards", "Background=BG", "background=BG", "底=BG", "背景图=BG", "前往按钮=Go_Button", "前往=Go", "卡带=Card", "卡片=Card", "卡=Card", "装饰品=Ornament", "装饰=Deco", "左上角=TopLeft", "右上角=TopRight", "左下角=BottomLeft", "右下角=BottomRight", "左上=TopLeft", "右上=TopRight", "左下=BottomLeft", "右下=BottomRight", "GuideKey=GuideKey", "TitleBg=Title_BG", "MainBg=Main_BG", "IconBg=Icon_BG", "Bp=BattlePass", "AMatch=ArenaMatch",
    "VX=VFX"
  ].join("\n"),
  contextDocs: [
    "命名结构固定为：T_UI_用户填写工程名_AI生成语义名。工程名只能来自用户填写的当前界面工程名，不能由 AI 从历史模块名自动生成。",
    "历史命名常见结构：T_UI_Img_工程名_语义_状态、T_UI_Icon_工程名_动作、T_UI_Bg_工程名_用途。Img/Icon/Bg/Btn/Line/Mask/Frame/Light/Tab 等词可作为内容语义参考。",
    "图片尺寸规律：64x64、128x128、256x256、512x512 多为 Icon/Badge；宽高比大于 3 且高度较小多为 Line/Bar/Progress；3440x1440、2048x1024、1024x512 等大图优先视为 BG/MainBg/PanelBg；方形大图常见 Mask、Frame、Badge、AvatarMask。",
    "状态词习惯：Normal/Nml 表示常态，Sel/Select/Selected 表示选中，UnSel 表示未选，Disabled/Forbidden 表示禁用，Check/Pick/Ban/Lock/Unlock 可作为状态或行为后缀。",
    "颜色/方向可作为末尾限定词保留：Red、Blue、Yellow、Black、White、Left、Right、Top、Bottom、Big、Small。"
  ].join("\n")
};

const ngrTemplateSchemeNames = ["NGR Icons命名规范", "NGR图集命名规范"];
const ngrTemplateSchemes = [
  {
    ...defaultRules,
    schemeName: "NGR Icons命名规范",
    basePrefix: "T_UI_Icon",
    projectName: "NGR",
    separator: "_",
    tags: "BG, Button, Hover, Normal, Icon, Item, Line, Bar, ProgressBar, Frame, Mask, Light, Pattern, Tab, Card, Selected, Forbidden, Lock, Unlock",
    pageTerms: "Home\nLogin\nProfile\nSettings",
    componentTerms: ngrTrainingKnowledge.componentTerms,
    stateTerms: ngrTrainingKnowledge.stateTerms,
    filenameRules: ngrTrainingKnowledge.filenameRules,
    contextDocs: [
      "该项目由驼峰命名规则首字母大写。该切图全部是 Icon，需要参考图片的中文进行英文翻译填写；如果英文翻译比较难，就使用拼音填写。",
      "可以根据切图自带的中文命名进行英文翻译，使用简洁的英文填入。",
      "命名结构固定为：T_UI_Icon_用户填写工程名_AI生成语义名。工程名只能来自当前界面工程名，不允许 AI 使用工程目录名作为语义词。",
      ngrTrainingKnowledge.contextDocs
    ].join("\n"),
  },
  {
    ...defaultRules,
    schemeName: "NGR图集命名规范",
    basePrefix: "T_UI",
    projectName: "NGR",
    separator: "_",
    tags: "BG, Button, Hover, Normal, Icon, Item, Line, Bar, ProgressBar, Frame, Mask, Light, Pattern, Tab, Card, Selected, Forbidden, Lock, Unlock",
    pageTerms: "Home\nLogin\nProfile\nSettings",
    componentTerms: ngrTrainingKnowledge.componentTerms,
    stateTerms: ngrTrainingKnowledge.stateTerms,
    filenameRules: ngrTrainingKnowledge.filenameRules,
    contextDocs: [
      "该项目由驼峰命名规则首字母大写。命名应优先使用英文 Pascal Case 词组但要支持公认的缩写英文，并用下划线连接，例如 Home_Button_Normal。",
      "根据图片的相似性重点识别不同状态切图 Button、Normal、Hover、Active、Disabled 等按钮状态。",
      "可以根据切图自带的中文命名进行英文翻译，使用简洁的英文填入。",
      "命名结构固定为：T_UI_用户填写工程名_AI生成语义名。工程名只能来自当前界面工程名，不允许 AI 使用工程目录名作为语义词。",
      ngrTrainingKnowledge.contextDocs
    ].join("\n"),
  },
];

const builtinTranslations = {
  首页: "Home",
  主页: "Home",
  登录: "Login",
  登陆: "Login",
  个人中心: "Profile",
  我的: "Profile",
  设置: "Settings",
  背景: "BG",
  底图: "BG",
  背景图: "BG",
  底: "BG",
  底板: "BG",
  底纹: "Pattern",
  前往按钮: "Go_Button",
  前往: "Go",
  按钮: "Button",
  图标: "Icon",
  导航: "Nav",
  横幅: "Banner",
  模块: "Item",
  页面: "Page",
  页: "Page",
  场景: "Scene",
  商店: "Shop",
  商城: "Shop",
  森林: "Forest",
  市场: "Market",
  营业: "Business",
  经营: "Business",
  记录: "Record",
  控件: "Control",
  遮罩: "Mask",
  覆盖层: "Overlay",
  覆盖: "Overlay",
  标题: "Title",
  游历: "Travel",
  外出游历: "Travel_Journal",
  日志: "Journal",
  手札: "Journal",
  札记: "Note",
  笔记: "Note",
  冒险: "Adventure",
  旅程: "Journey",
  白菊: "White_Chrysanthemum",
  菊花: "Chrysanthemum",
  花: "Flower",
  左上角: "TopLeft",
  右上角: "TopRight",
  左下角: "BottomLeft",
  右下角: "BottomRight",
  左上: "TopLeft",
  右上: "TopRight",
  左下: "BottomLeft",
  右下: "BottomRight",
  上: "Top",
  下: "Bottom",
  左: "Left",
  右: "Right",
  奖励: "Rewards",
  礼物: "Gift",
  礼包: "Gift",
  货币: "Coin",
  金币: "Gold",
  钻石: "Diamond",
  任务: "Task",
  任务栏: "Task",
  邮件: "Mail",
  背包: "Bag",
  地图: "Map",
  技能: "Skill",
  排行: "Rank",
  排名: "Rank",
  提示: "Tips",
  公告: "Notice",
  标签: "Tag",
  输入框: "Input",
  滑条: "Slider",
  开关: "Switch",
  弹窗: "Popup",
  弹框: "Popup",
  对话框: "Dialog",
  窗口: "Window",
  面板: "Panel",
  卡带: "Card",
  卡片: "Card",
  卡: "Card",
  边框: "Frame",
  框: "Frame",
  线: "Line",
  线条: "Line",
  分割线: "Divider",
  进度: "ProgressBar",
  进度条: "ProgressBar",
  光效: "Light",
  光: "Light",
  阴影: "Shadow",
  纹理: "Pattern",
  装饰品: "Ornament",
  装饰: "Deco",
  角标: "Badge",
  头像: "Avatar",
  头像框: "Avatar_Frame",
  立绘: "Portrait",
  常态: "Normal",
  普通: "Normal",
  默认: "Normal",
  悬浮: "Hover",
  按下: "Pressed",
  按压: "Pressed",
  选中: "Active",
  未选中: "Unselected",
  点击: "Active",
  激活: "Active",
  禁用: "Disabled",
  不可用: "Disabled",
  锁定: "Lock",
  解锁: "Unlock",
  打开: "Open",
  关闭: "Close",
  开启: "On",
  勾选: "Checked",
  焦点: "Focus",
  新增: "New",
  热门: "Hot",
  横向: "Horizontal",
  竖向: "Vertical",
  红: "Red",
  蓝: "Blue",
  黄: "Yellow",
  绿: "Green",
  黑: "Black",
  白: "White",
  金: "Gold",
  紫: "Purple",
  橙: "Orange",
  灰: "Gray",
  亮: "Light",
  暗: "Dark",
};
