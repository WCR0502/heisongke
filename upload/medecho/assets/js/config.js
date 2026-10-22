/* =========================================================
   同频 MedEcho · 本地配置
   ---------------------------------------------------------
   高德的能力分两条通道，Key 的用途也不同：

   ① JS API Key（本文件 amapKey）—— 负责「真实底图」渲染
      类型：Web端 (JS API)
      2021 年后新建的 Key 需要配对「安全密钥 jscode」，填到
      amapSecurityCode；当前这个 Key 无需配对，留空即可。

   ② Web 服务 Key —— 负责「逆地理 + 附近医院搜索」
      不放这里，放服务端 llm.config.json 的 amapWebKey，
      浏览器永远拿不到。未配置时前端自动落回内置演示数据。

   注：当前两条通道用的是同一个 Key（两类服务都已开通）。
   若日后拆成两个 Key，按上面分工分别填写即可。
   ========================================================= */

window.APP_CONFIG = {
  useAmap: true,
  amapKey: '1c0d7075d16088c0ebb14e1f790f9179',
  amapSecurityCode: '',

  /* AI 接口地址：
     留空 = 同源，走本地 server.js 或 Vercel 自带的 /api/llm
     线上接 Cloudflare Worker 时填 https://medecho-llm.<你的子域>.workers.dev */
  llmBase: ''
};
