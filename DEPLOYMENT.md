# Production Deployment Guide — Concertos WhatsApp Engine

## Architecture

```
GitHub repo ──[push]──► GitHub Actions ──[docker build]──► GHCR
                                                            │
                                                     [docker pull]
                                                            │
                                                        AWS VPS
                                                            │
                                               docker-compose.prod.yml
                                                            │
                                            concerts-whatsapp container :3000
```

## GitHub Actions Setup

### 1. Add Secrets to GitHub Repo

Navigate to: `https://github.com/growtagxinc/whatsappbk/settings/secrets/actions`

Add these **Repository Secrets**:

| Secret Name | Value | Notes |
|---|---|---|
| `VPS_HOST` | `13.126.133.118` | Your AWS VPS public IP |
| `VPS_USER` | `ec2-user` | SSH user for VPS |
| `VPS_SSH_KEY` | Contents of `concertos_new.pem` | Paste entire private key including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` |

### 2. Workflow File

The CI/CD workflow is at `.github/workflows/deploy.yml`.

- **Triggers:** Every push to `main` or `master`, plus manual trigger via `workflow_dispatch`
- **Build:** Docker image built with BuildKit, pushed to `ghcr.io/growtagxinc/concertos-whatsapp`
- **Deploy:** SSH to VPS, pull latest image, zero-downtime restart

## VPS Setup

### 1. Install Docker (if not already installed)

```bash
# SSH into VPS
ssh -i concertos_new.pem ec2-user@13.126.133.118

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ec2-user

# Install Docker Compose v2
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Enable Docker
sudo systemctl enable docker
sudo systemctl start docker
```

### 2. Create Production Environment File

On VPS, create `.env.prod` with production secrets:

```bash
# SSH into VPS
ssh -i concertos_new.pem ec2-user@13.126.133.118

cd ~/brandpro-project/concertos-whatsapp
nano .env.prod
```

Paste these variables (update values from your production secrets):

```env
# WhatsApp Meta Cloud API
PORT=3000
WHATSAPP_TOKEN=EAAAh2H92vWhg...   # From Meta Developer Console
WHATSAPP_PHONE_NUMBER_ID=1081418555051634
WHATSAPP_VERIFY_TOKEN=sdijcnioqdwj...   # Random string for webhook verification

# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/brandpro
REDIS_URL=rediss://user:pass@upstash-instance.upstash.io:6380

# AI
GROQ_API_KEY=gsk_...
OPENROUTER_API_KEY=sk-or-v1-...

# Auth
JWT_SECRET=<generate-a-strong-random-secret>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://dash.concertos.brandproinc.in/settings

# Limits
ALLOW_UNAUTHENTICATED=false
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_MESSAGES=30

# WhatsApp Engine
USE_BAILEYS=false

# Admin
ADMIN_WHATSAPP_NUMBER=918178081629

# Paperclip
PAPERCLIP_API_URL=https://api.paperclip.ai/api
PAPERCLIP_COMPANY_ID=3f5eb104-ecdd-4621-8ebb-951a2cd9efb1
```

### 3. Docker Named Volumes (auto-created on first run)

```bash
docker volume create concertos-wwebjs
docker volume create concertos-logs
```

### 4. Run Production Compose

```bash
cd ~/brandpro-project/concertos-whatsapp
docker compose -f docker-compose.prod.yml up -d
```

## Zero-Downtime Deployment (via GitHub Actions)

1. Push to `main` branch → GitHub Actions triggers automatically
2. Actions builds Docker image → pushes to GHCR
3. Actions SSH to VPS → pulls image → stops old container → starts new container
4. Health check runs (30s timeout per check, 3 retries)
5. If health check fails → container is stopped, rollback is automatic

## Rollback Procedure

### Quick Rollback (previous image)

```bash
ssh -i concertos_new.pem ec2-user@13.126.133.118

# List recent images
docker images ghcr.io/growtagxinc/concertos-whatsapp

# Get previous image tag
docker pull ghcr.io/growtagxinc/concertos-whatsapp:<previous-sha>

# Stop current
docker stop concertos-whatsapp
docker rm concertos-whatsapp

# Start with previous
docker run -d \
  --name concertos-whatsapp \
  --restart always \
  --env-file .env.prod \
  -p 80:3000 \
  -v concertos-wwebjs:/app/.wwebjs_auth \
  ghcr.io/growtagxinc/concertos-whatsapp:<previous-sha>
```

### Automatic Rollback

GitHub Actions workflow includes automatic rollback if health check fails after 30 attempts.

## Monitoring

### Health Endpoint

```bash
curl http://13.126.133.118/health
```

Expected response:
```json
{
  "status": "UP",
  "whatsapp": "READY",
  "hasActiveQR": false,
  "isLoaded": true,
  "baileys": { "status": "READY", "connected": true }
}
```

### Container Logs

```bash
docker logs --tail 50 concertos-whatsapp
docker logs --follow concertos-whatsapp
```

### System Resources

```bash
docker stats --no-stream
free -m
df -h
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs concertos-whatsapp

# Verify .env.prod exists and has required vars
docker run --rm --env-file .env.prod ghcr.io/growtagxinc/concertos-whatsapp:latest node -e "console.log('ok')"

# Check port conflicts
ss -tlnp | grep :80
```

### Health check failing

```bash
# Test manually
docker exec concertos-whatsapp wget -qO- http://localhost:3000/health

# Check MongoDB/Redis connectivity from container
docker exec concertos-whatsapp node -e "console.log(process.env.MONGODB_URI)"
```

### WhatsApp session lost after redeploy

WhatsApp sessions are stored in the `concertos-wwebjs` named volume. They persist across deployments as long as the volume isn't deleted. If sessions are lost:

```bash
# Verify volume exists
docker volume inspect concertos-wwebjs

# If corrupted, you may need to re-scan QR codes
# Sessions are linked to phone numbers via .wwebjs_auth/session_<clientId> files
```

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Internal container port (default: 3000) |
| `NODE_ENV` | Yes | Set to `production` |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `REDIS_URL` | Yes | Redis/Upstash connection string |
| `GROQ_API_KEY` | Yes | Groq API key for AI features |
| `OPENROUTER_API_KEY` | No | OpenRouter key (falls back to Groq) |
| `JWT_SECRET` | Yes | Secret for JWT signing |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Yes | Google OAuth redirect URI |
| `ALLOW_UNAUTHENTICATED` | Yes | `false` in production |
| `RATE_LIMIT_WINDOW_MS` | Yes | Rate limit window in ms |
| `RATE_LIMIT_MAX_MESSAGES` | Yes | Max messages per window |
| `USE_BAILEYS` | Yes | Set to `false` for Puppeteer fallback |
| `ADMIN_WHATSAPP_NUMBER` | Yes | Admin WhatsApp number |
| `PAPERCLIP_API_URL` | Yes | Paperclip API URL |
| `PAPERCLIP_COMPANY_ID` | Yes | Paperclip company ID |
