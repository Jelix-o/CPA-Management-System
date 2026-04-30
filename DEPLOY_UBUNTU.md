# Ubuntu 26 部署指南

这套部署方式把代码、数据、密钥分开：

- 代码目录：`/opt/cpamc-sidecar`
- 数据目录：`/var/lib/cpamc-sidecar`
- 环境变量：`/etc/cpamc-sidecar/cpamc-sidecar.env`
- 运行方式：`systemd`
- 对外访问：推荐用 `Nginx -> 127.0.0.1:8787`

## 1. 在本地打包

在 Windows 本地项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1
```

生成文件：

```text
dist/cpamc-sidecar-manager.zip
```

这个压缩包不会包含 `.env`、`data/`、截图和临时日志。

## 2. 上传到服务器

把压缩包上传到服务器 `/tmp/`。如果你本机有 `scp`：

```powershell
scp .\dist\cpamc-sidecar-manager.zip root@你的服务器IP:/tmp/
```

也可以用 Xftp、宝塔文件管理器或云厂商控制台上传。

## 3. 安装基础软件

登录 Ubuntu 服务器：

```bash
ssh root@你的服务器IP
```

安装 unzip 和 nginx：

```bash
sudo apt update
sudo apt install -y unzip nginx
```

检查 Node：

```bash
node -v
npm -v
```

本系统要求 Node.js 18+。如果你的服务器已经是 Node 24，可以跳过 Node 安装。

如果没有 Node，先尝试：

```bash
sudo apt install -y nodejs npm
node -v
```

如果版本低于 18，再安装 Node 24：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

## 4. 创建运行用户和目录

```bash
sudo useradd --system --home /opt/cpamc-sidecar --shell /usr/sbin/nologin cpamc || true
sudo mkdir -p /opt/cpamc-sidecar /var/lib/cpamc-sidecar /etc/cpamc-sidecar
sudo chown -R cpamc:cpamc /opt/cpamc-sidecar /var/lib/cpamc-sidecar
sudo chmod 750 /opt/cpamc-sidecar /var/lib/cpamc-sidecar /etc/cpamc-sidecar
```

## 5. 解压代码

```bash
sudo unzip -o /tmp/cpamc-sidecar-manager.zip -d /opt/cpamc-sidecar
sudo chown -R cpamc:cpamc /opt/cpamc-sidecar
```

项目没有第三方 npm 依赖，通常不需要 `npm install`。你仍然可以执行一次检查：

```bash
cd /opt/cpamc-sidecar
npm run check
```

## 6. 写入生产配置

复制配置模板：

```bash
sudo cp /opt/cpamc-sidecar/deploy/cpamc-sidecar.env.example /etc/cpamc-sidecar/cpamc-sidecar.env
sudo chown root:cpamc /etc/cpamc-sidecar/cpamc-sidecar.env
sudo chmod 640 /etc/cpamc-sidecar/cpamc-sidecar.env
```

生成会话密钥：

```bash
cd /opt/cpamc-sidecar
npm run secret
```

编辑配置：

```bash
sudo nano /etc/cpamc-sidecar/cpamc-sidecar.env
```

重点改这些：

```ini
APP_HOST=127.0.0.1
APP_PORT=8787
APP_DATA_DIR=/var/lib/cpamc-sidecar
APP_SESSION_SECRET=粘贴刚才 npm run secret 输出的长随机字符串

# 如果 CPAMC 和本系统在同一台服务器，优先用本机地址
CPAMC_BASE_URL=http://127.0.0.1:8317
CPAMC_MANAGEMENT_KEY=你的 CPAMC 管理密码或管理 Key

# 管理员 API Key，多个用英文逗号分隔
ADMIN_API_KEYS=sk-xxx
```

如果 CPAMC 没有监听 `127.0.0.1:8317`，就把 `CPAMC_BASE_URL` 改成它实际可访问的地址，例如：

```ini
CPAMC_BASE_URL=http://114.132.237.115:8317
```

## 7. 部署 systemd 服务

```bash
sudo cp /opt/cpamc-sidecar/deploy/cpamc-sidecar.service /etc/systemd/system/cpamc-sidecar.service
sudo systemctl daemon-reload
sudo systemctl enable --now cpamc-sidecar
```

检查状态：

```bash
sudo systemctl status cpamc-sidecar --no-pager
curl http://127.0.0.1:8787/api/health
```

看日志：

```bash
sudo journalctl -u cpamc-sidecar -f
```

## 8. 配置 Nginx 域名访问

把模板复制到 Nginx：

```bash
sudo cp /opt/cpamc-sidecar/deploy/nginx-cpamc-sidecar.conf /etc/nginx/sites-available/cpamc-sidecar
sudo ln -sf /etc/nginx/sites-available/cpamc-sidecar /etc/nginx/sites-enabled/cpamc-sidecar
sudo nginx -t
sudo systemctl reload nginx
```

模板里的域名默认是：

```nginx
server_name 9958.uk www.9958.uk;
```

如果你换了域名，先编辑：

```bash
sudo nano /etc/nginx/sites-available/cpamc-sidecar
sudo nginx -t
sudo systemctl reload nginx
```

防火墙只需要开放 80/443，不建议直接开放 8787：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

## 9. HTTPS

如果你用 Cloudflare 代理域名，最简单是让 Cloudflare 访问服务器 80 端口。

更推荐在源站也上证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 9958.uk -d www.9958.uk
```

然后在 Cloudflare 把 SSL/TLS 模式设为 `Full` 或 `Full (strict)`。

## 10. 升级以后怎么发版

以后本地改完重新打包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1
scp .\dist\cpamc-sidecar-manager.zip root@你的服务器IP:/tmp/
```

服务器上执行：

```bash
sudo systemctl stop cpamc-sidecar
sudo unzip -o /tmp/cpamc-sidecar-manager.zip -d /opt/cpamc-sidecar
sudo chown -R cpamc:cpamc /opt/cpamc-sidecar
sudo systemctl start cpamc-sidecar
sudo systemctl status cpamc-sidecar --no-pager
```

升级时不要覆盖：

```text
/etc/cpamc-sidecar/cpamc-sidecar.env
/var/lib/cpamc-sidecar
```

## 11. 常用排错

服务起不来：

```bash
sudo journalctl -u cpamc-sidecar -n 100 --no-pager
```

端口是否监听：

```bash
ss -lntp | grep 8787
```

本机健康检查：

```bash
curl http://127.0.0.1:8787/api/health
```

权限检查：

```bash
sudo -u cpamc bash -lc 'set -a; source /etc/cpamc-sidecar/cpamc-sidecar.env; set +a; cd /opt/cpamc-sidecar; node scripts/doctor.js'
```

如果登录失败，优先检查：

- `CPAMC_BASE_URL` 是否能从服务器访问
- `CPAMC_MANAGEMENT_KEY` 是否正确
- `ADMIN_API_KEYS` 是否填了你要作为管理员登录的 CPAMC API Key
- `CPAMC_VALIDATE_LOGIN=true` 时，该 API Key 是否能正常访问 CPAMC `/v1/models`
