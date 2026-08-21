# Timeline Visualizer Web

把 Google 地圖匯出的 `Timeline.json`，直接在瀏覽器中製作成 Timeline Visualizer Android App 風格的旅程動畫與 H.264 MP4。

## 重點功能

- JSON、座標、標題與影片全程留在目前瀏覽器分頁，不上傳到應用程式伺服器。
- 支援新版直接陣列與 `semanticSegments` Timeline JSON。
- 依 Android App v2.2.5 的動畫規則呈現：長途節奏壓縮、三層動態尾跡、平穩／固定／動態鏡頭，以及 1.5 秒完整旅程結尾。
- 距離單位可設為自動、公里或英里，摘要、預覽與輸出影片會一致套用。
- 正方形 480p／720p／1080p、直式 1080×1920、橫式 1920×1080。
- 完整時長預覽、時間軸拖曳、暫停／繼續、10–300 秒影片。
- 保守 GPS 異常點篩選；不修改原始 JSON。
- 使用 WebCodecs 與 Mediabunny，在瀏覽器內建立 MP4。

## 隱私

Timeline 檔案不會送出此裝置。只有在使用者明確同意後，網站才會向 CARTO 請求旅程範圍的 OpenStreetMap 圖磚；圖磚座標可能讓 CARTO 推知被瀏覽的地理區域。完整說明見網站內的「隱私說明」。

公開網站使用 Cloudflare Web Analytics 取得彙總流量資料；不會將 Timeline 內容、座標、選取日期、標題或產生的影片加入分析事件。

## 本機開發

需要 Node.js 24 與 pnpm 11。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm dev
```

正式建置：

```bash
pnpm build
```

## GitHub Pages

`.github/workflows/pages.yml` 會在 `main` 分支更新時測試、建置並部署 `dist/`，並在第一次部署時啟用 GitHub Pages。

Vite 使用相對資產路徑，因此不論儲存庫名稱為何，都能部署到 `https://<使用者>.github.io/<儲存庫>/`。

## 來源與授權

本專案以 [mahlernim/google-timeline-visualizer](https://github.com/mahlernim/google-timeline-visualizer) v2.2.5 為基礎，並將 Android App 的動畫與輸出行為移植到網頁環境。原專案採 MIT License；請保留 [LICENSE](./LICENSE) 與 [NOTICE.md](./NOTICE.md)。Mediabunny 與其他第三方資訊見 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

地圖與輸出影片中的 attribution 必須保留：© OpenStreetMap contributors、© CARTO。
