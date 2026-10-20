# Deploying the dashboard to Vercel

Vercel hosts static sites and short-lived serverless functions. It cannot run
RideFlow's backend: the five services, Redis, Prometheus, Grafana and the two
injectors are long-running containers, and the chaos injector needs the Docker
socket. So the deployment is split:

| Part | Where it runs |
|---|---|
| Mission Control dashboard (React app in `frontend/`, built by Vercel) | **Vercel** |
| `/api/chaos/*`, `/api/security/*`, `/api/app/*` proxy (`api/proxy.js`, Node.js) | **Vercel** (serverless function) |
| Everything else (`docker-compose.yml`) | A server you control, e.g. the free-tier EC2 box in `infra/free-tier-ec2/` |

The browser only talks to Vercel over HTTPS; the proxy function forwards
control-API calls to the backend server-side. That avoids mixed-content
blocking (an HTTPS page can't call an `http://` backend) and CORS.

## 1. Run the backend somewhere reachable

Follow `infra/free-tier-ec2/README.md`. Vercel's outbound IPs aren't fixed, so
the chaos/security ports must be reachable from the internet:

```bash
cd infra/free-tier-ec2
terraform apply -var="instance_type=t3.medium"   # allowed_app_cidr defaults to 0.0.0.0/0
```

Note the `public_ip` output.

## 2. Import the repo into Vercel

1. vercel.com → **Add New… → Project** → import this GitHub repo.
2. Leave **Framework Preset** as *Other* and the root directory as `./`.
   `vercel.json` already sets the install/build commands (`npm ci` +
   `npm run build` in `frontend/`), the output directory (`frontend/dist`),
   the function, the `/api/*` rewrites and the SPA fallback.
3. Under **Environment Variables** add:

   | Name | Value |
   |---|---|
   | `DASHBOARD_PASSWORD` | **Required.** A password. The dashboard asks for it once per tab; without it anyone with the URL could run chaos experiments, so the Backend box (below) refuses to work until it is set |
   | `RIDEFLOW_BACKEND_URL` | Optional default backend, `http://<public_ip>` (no port). Only used when the Backend box is empty |

   Optional: `RIDEFLOW_CHAOS_URL` / `RIDEFLOW_SECURITY_URL` to override the
   default `<backend>:9000` / `<backend>:9001`.
4. **Deploy.** Every push to `main` redeploys automatically; other branches
   get preview URLs.

## 3. Connect the dashboard to the backend

Open the Vercel URL, enter the password, then type the EC2 instance's
**Public IPv4 address** into the **Backend** box at the top and press
**Connect**. The dot turns green when both injectors answer.

An EC2 public IP changes on every stop/start. Nothing needs redeploying:
start the instance, wait about two minutes (every container has
`restart: unless-stopped`, so the whole stack comes back by itself), paste the
new IP into the Backend box and press Connect. The address is remembered in
that browser.

## How it behaves

- When `DASHBOARD_PASSWORD` is set, the dashboard asks for it once per
  browser tab and sends it with every `/api` call.
- The Backend box's address goes to the proxy in the `X-RideFlow-Backend`
  header. The proxy only accepts public hosts (no loopback, private,
  link-local/metadata or `.internal` addresses) and only when
  `DASHBOARD_PASSWORD` is set, so it can't be used as an open relay.
- While the backend is unreachable the dashboard shows why in a banner,
  stops polling, and retries every 10 seconds.
- **Run experiment** returns after at most 20s with "started"; the run keeps
  going on the backend and the dashboard's 2s polling shows its progress.
  Chaos experiments last minutes, far past a serverless function's timeout.
- The Grafana/Prometheus links in the sidebar point straight at the backend
  (`http://<public_ip>:3001` / `:9090`).
- The same React build also runs in the compose stack's `dashboard`
  container (`http://localhost:5173`, or `http://<public_ip>:5173` on EC2),
  where nginx (`frontend/nginx.conf`) provides the same `/api/*` routes, so
  no password or Backend box is needed there.
- `/api/app/*` reaches only the gateway's public `/v1/*` API (the Ride App
  page). The rider's JWT travels in `X-App-Authorization` because
  `Authorization` carries the dashboard password.

## Security caveat

`DASHBOARD_PASSWORD` protects the Vercel proxy only. The backend's own ports
(9000/9001 and the rest) are still open on the EC2 box itself, and the chaos
injector has the Docker socket mounted. Treat the box as a short-lived demo
environment and `terraform destroy` it when you're done.
