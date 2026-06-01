export const translations = {
  en: {
    nav: {
      features: "Features",
      ai: "AI Analysis",
      download: "Download",
      github: "GitHub",
    },
    hero: {
      headline: "React Go",
      subtitle: "A Modern Go/Weiqi Game with AI Integration",
      description:
        "Play Go with friends or challenge AI powered by KataGo. Smart review, real-time analysis, and an authentic board experience — all in a lightweight desktop app.",
      downloadBtn: "Download for macOS",
      githubBtn: "View on GitHub",
      sizeNote: "Apple Silicon · ~6 MB",
    },
    features: {
      title: "Features",
      subtitle: "Everything you need for a great Go experience",
      items: [
        {
          icon: "players",
          title: "Player vs Player",
          description:
            "Play locally with a friend on 9×9, 13×13, or 19×19 boards with full rule enforcement.",
        },
        {
          icon: "robot",
          title: "Player vs AI",
          description:
            "Four difficulty levels from Beginner to Strongest. Perfect for players of all skill levels.",
        },
        {
          icon: "brain",
          title: "KataGo Engine",
          description:
            "Powered by state-of-the-art neural network engine with one-click setup on desktop.",
        },
        {
          icon: "offline",
          title: "Offline AI Fallback",
          description:
            "Built-in Monte Carlo AI works entirely in your browser — no installation required.",
        },
        {
          icon: "review",
          title: "Smart Review",
          description:
            "Post-game analysis with slider navigation. Explore every move with AI-powered insights.",
        },
        {
          icon: "analysis",
          title: "AI Move Analysis",
          description:
            "Real-time top candidate moves with winrate percentages, score estimates, and heat maps.",
        },
        {
          icon: "pv",
          title: "Variation Explorer",
          description:
            "Visualize predicted move sequences on the board. Hover to see principal variations.",
        },
        {
          icon: "authentic",
          title: "Authentic Experience",
          description:
            "Realistic wooden board, stone sounds, and ambient stream BGM crafted with Web Audio API.",
        },
      ],
    },
    aiShowcase: {
      title: "AI-Powered Analysis",
      subtitle: "See the game through the eyes of a professional AI",
      winrate: "Winrate Tracking",
      winrateDesc:
        "Real-time winrate chart tracks game progression. Instantly see how each move affects the outcome.",
      candidates: "Candidate Moves",
      candidatesDesc:
        "Top 4 move recommendations with winrate percentages and score leads displayed directly on the board.",
      pv: "Principal Variation",
      pvDesc:
        "Hover over any candidate to see the predicted sequence played out with numbered stones on the board.",
    },
    download: {
      title: "Download",
      subtitle: "Get React Go for your platform",
      macos: "macOS",
      macosNote: "Apple Silicon (M1/M2/M3/M4)",
      macosBtn: "Download DMG",
      windows: "Windows",
      windowsNote: "Coming Soon",
      windowsBtn: "Not Available",
      linux: "Linux",
      linuxNote: "Coming Soon",
      linuxBtn: "Not Available",
      sourceNote:
        "All downloads are also available on",
      sourceLink: "GitHub Releases",
    },
    techStack: {
      title: "Built with Modern Tech",
      items: [
        { name: "React 19", desc: "UI Framework" },
        { name: "Tauri 2", desc: "Desktop Runtime" },
        { name: "KataGo", desc: "AI Engine" },
        { name: "TypeScript", desc: "Type Safety" },
        { name: "Vite", desc: "Build Tool" },
      ],
    },
    footer: {
      description: "A modern Go/Weiqi game with AI integration.",
      links: "Links",
      community: "Community",
      github: "GitHub",
      issues: "Report a Bug",
      license: "MIT License",
      builtWith: "Built with Astro",
    },
  },
  zh: {
    nav: {
      features: "功能特性",
      ai: "AI 分析",
      download: "下载",
      github: "GitHub",
    },
    hero: {
      headline: "React Go",
      subtitle: "现代化的围棋对弈与 AI 分析工具",
      description:
        "与朋友对弈或挑战 KataGo AI 驱动的智能对手。智能复盘、实时分析、拟真棋盘体验——轻量级桌面应用。",
      downloadBtn: "下载 macOS 版",
      githubBtn: "查看 GitHub",
      sizeNote: "Apple Silicon · 约 6 MB",
    },
    features: {
      title: "功能特性",
      subtitle: "你所需的一切围棋体验",
      items: [
        {
          icon: "players",
          title: "双人对弈",
          description: "支持 9×9、13×13、19×19 棋盘，完整规则引擎。",
        },
        {
          icon: "robot",
          title: "人机对弈",
          description: "四个难度等级，从初学者到最强，适合各级别玩家。",
        },
        {
          icon: "brain",
          title: "KataGo 引擎",
          description: "业界领先的神经网络围棋引擎，桌面版一键安装。",
        },
        {
          icon: "offline",
          title: "离线 AI",
          description: "内置蒙特卡洛 AI，完全在浏览器中运行，无需安装。",
        },
        {
          icon: "review",
          title: "智能复盘",
          description: "滑动条逐手导航，AI 辅助的深度对局分析。",
        },
        {
          icon: "analysis",
          title: "AI 实时分析",
          description: "实时显示推荐着点、胜率百分比、目数估计和热力图。",
        },
        {
          icon: "pv",
          title: "变化图",
          description: "悬停查看预测行棋序列，棋盘上以编号棋子展示变化。",
        },
        {
          icon: "authentic",
          title: "拟真体验",
          description: "仿木纹棋盘、落子音效、流水背景音，Web Audio API 精心打造。",
        },
      ],
    },
    aiShowcase: {
      title: "AI 驱动的分析",
      subtitle: "以专业 AI 的视角审视棋局",
      winrate: "胜率追踪",
      winrateDesc: "实时胜率曲线追踪棋局走势，直观感受每步棋的影响。",
      candidates: "推荐着点",
      candidatesDesc: "前 4 个推荐着点及胜率、目数差，直接显示在棋盘上。",
      pv: "主要变化",
      pvDesc: "悬停推荐着点即可在棋盘上预览预测行棋序列。",
    },
    download: {
      title: "下载",
      subtitle: "获取 React Go",
      macos: "macOS",
      macosNote: "Apple Silicon (M1/M2/M3/M4)",
      macosBtn: "下载 DMG",
      windows: "Windows",
      windowsNote: "即将推出",
      windowsBtn: "暂不可用",
      linux: "Linux",
      linuxNote: "即将推出",
      linuxBtn: "暂不可用",
      sourceNote: "所有下载也可在",
      sourceLink: "GitHub Releases",
    },
    techStack: {
      title: "现代技术栈",
      items: [
        { name: "React 19", desc: "UI 框架" },
        { name: "Tauri 2", desc: "桌面运行时" },
        { name: "KataGo", desc: "AI 引擎" },
        { name: "TypeScript", desc: "类型安全" },
        { name: "Vite", desc: "构建工具" },
      ],
    },
    footer: {
      description: "现代化的围棋对弈与 AI 分析工具。",
      links: "链接",
      community: "社区",
      github: "GitHub",
      issues: "报告问题",
      license: "MIT 许可证",
      builtWith: "使用 Astro 构建",
    },
  },
} as const;

export type Lang = "en" | "zh";
