| Lệnh | Tác dụng |
| --- | --- |
| `node --version` | Kiểm tra Node.js từ 22. |
| `docker compose version` | Kiểm tra Docker Desktop và Compose. |
| `npm ci` | Cài dependency theo lockfile. |
| `npm run demo:start` | Khởi động chain, deploy, cấu hình governance và chạy UI tại http://127.0.0.1:5173. |
| `npm run demo:ui` | Chạy UI với deployment hiện có. |
| `npm run demo:prepare` | Chuẩn bị chain và hợp đồng, chưa mở UI. |
| `npm run demo:doctor` | Kiểm tra điều kiện chạy demo. |
| `npm run besu:health` | Kiểm tra validator, peer và block. |
| `npm run besu:up` | Khởi động các node Besu. |
| `docker compose -f networks/besu/docker-compose.yml stop` | Dừng node, giữ dữ liệu. |
| `npm run demo:reset` | Xóa dữ liệu chain và tạo lại deployment. |
| `npm run compile` | Biên dịch hợp đồng. |
| `npm test` | Test hợp đồng, service và liên kết thành phần UI; bao gồm invariant. |
| `npm run test:browser` | Test UI desktop, không chụp ảnh. |
| `npx playwright install chromium` | Cài browser kiểm thử nếu chưa có Chromium hoặc Edge. |
| `npm run institutional:integration` | Test luồng liên chain trên runtime hiện có. |
| `npm run institutional:governance` | Hoàn tất chuyển quyền sang timelock. |
| `npm run security:test` | Test các tình huống bảo mật. |
| `npm run mpt:corpus:verify` | Xác minh dữ liệu proof kiểm thử. |
| `npm run institutional:evidence` | Kiểm chứng trên hai chain cô lập và cập nhật mục Evidence. |
| `npm run institutional:evidence:verify` | Xác minh dữ liệu Evidence. |
| `npm run clean` | Dọn ảnh, tệp thử và cache test; giữ chain, khóa và journal. |
