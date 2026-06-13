import { defineConfig } from "vitepress";

const repo = "https://github.com/Automattic/kandelo";

export default defineConfig({
  title: "Kandelo Guide",
  description: "User-facing guide for booting Kandelo VFS images in the browser.",
  base: process.env.VITEPRESS_BASE ?? "/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/^https:\/\/github\.com\/Automattic\/kandelo/],
  themeConfig: {
    search: {
      provider: "local",
    },
    nav: [
      { text: "Guide", link: "/guide/current-ui" },
      { text: "API Stability", link: "/reference/api-stability" },
      { text: "Live UI", link: "https://automattic.github.io/kandelo/" },
      { text: "API Docs", link: "https://automattic.github.io/kandelo/api/" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Overview", link: "/" },
          { text: "Current Kandelo UI", link: "/guide/current-ui" },
          { text: "Your Own Browser App", link: "/guide/browser-apps" },
        ],
      },
      {
        text: "Images And Publishing",
        items: [
          { text: "VFS Images", link: "/guide/vfs-images" },
          { text: "Publish Software", link: "/guide/publish-software" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API Stability", link: "/reference/api-stability" },
          { text: "Troubleshooting", link: "/reference/troubleshooting" },
          { text: "Repo Docs", link: `${repo}/tree/main/docs` },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: repo },
    ],
    footer: {
      message: "Kandelo APIs are experimental and may change without notice.",
      copyright: "Published from the Kandelo repository.",
    },
  },
});
