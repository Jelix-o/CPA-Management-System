# CPAMC Sidecar Manager

一个独立于 CPAMC 源码的管理后台。用户使用 CPAMC 生成的 API Key 登录，本系统通过 CPAMC Management API 读取 usage，再按本地角色、别名、分组和限额规则展示数据。

## 功能

- API Key 登录，支持 `admin`、`viewer`、`user` 三种本地角色。
- 管理员查看全部 Key、模型和额度用量，普通用户只查看自己的 Key。
- 自定义时间范围：1 小时、24 小时、7 天、30 天和自定义起止时间。
- 请求趋势、Token 趋势、模型排行、Token 类型分布和洞察分析。
- 用户别名、备注、分组、多 API Key 绑定、启用/禁用、Token/请求限额。
- 本地配置备份、导入、自动备份和 CPAMC usage 快照。
- usage CSV/JSON 导出、审计日志、在线会话查看和踢下线。
- 服务器状态：CPU、内存、磁盘、进程、运行时间和 CPAMC 连通性。
- 主题、语言、密度、品牌名、Logo 文案、模型价格和权限策略可配置。

## 本地启动

复制配置：

```bash
cp .env.example .env
```

编辑 `.env` 后启动：

```bash
npm start
```

访问：

```text
http://127.0.0.1:8787/
```

## 生产部署

推荐 Ubuntu + systemd + Nginx：

```text
/opt/cpamc-sidecar                 代码目录
/var/lib/cpamc-sidecar             数据目录
/etc/cpamc-sidecar/cpamc-sidecar.env 生产环境变量
```

完整步骤见：

[DEPLOY_UBUNTU.md](./DEPLOY_UBUNTU.md)

本地生成部署压缩包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\make-release.ps1
```

输出：

```text
dist/cpamc-sidecar-manager.zip
```

压缩包不会包含 `.env`、`data/`、截图、日志或其他本地敏感文件。

## 配置项

核心配置示例：

```ini
APP_HOST=127.0.0.1
APP_PORT=8787
APP_DATA_DIR=/var/lib/cpamc-sidecar
APP_SESSION_SECRET=change-this-long-random-secret

CPAMC_BASE_URL=http://127.0.0.1:8317
CPAMC_MANAGEMENT_KEY=change-this

ADMIN_API_KEYS=
AUTO_CREATE_USERS=true
CPAMC_VALIDATE_LOGIN=true

AUTO_BACKUP_ENABLED=true
AUTO_BACKUP_RETENTION=14

USAGE_SNAPSHOT_ENABLED=true
USAGE_SNAPSHOT_INTERVAL_MINUTES=60
USAGE_SNAPSHOT_RETENTION=72
```

生产环境请使用：

```bash
node scripts/generate-secret.js
```

生成 `APP_SESSION_SECRET`。

## 数据文件

```text
data/users.json                 用户、角色、Key 哈希、别名、备注、限额
data/settings.json              主题、语言、价格、通知和权限设置
data/automation-state.json      自动日报等任务状态
data/audit.log                  审计日志
data/backups/*.json             手动或自动备份
data/usage-snapshots/*.json     CPAMC usage 快照
```

本系统不保存 API Key 明文，只保存 SHA-256 哈希和脱敏展示值。备份文件不包含 `.env` 中的 CPAMC 管理密钥。

## 安全建议

- 不要提交 `.env` 和 `data/`。
- 正式上线建议通过 HTTPS 反代访问。
- 如果不希望有效 CPAMC API Key 自动注册，把 `AUTO_CREATE_USERS=false`。
- `viewer` 能查看全局数据，是否允许导出由系统设置里的权限开关控制。
- “超限后自动禁用普通用户”默认关闭，开启前先确认限额配置合理。
