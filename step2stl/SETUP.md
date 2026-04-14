# STEP→STL Microservice — VPS Setup Guide

Standalone FastAPI service that accepts STEP file uploads and returns binary STL.
Runs on Ubuntu 22.04 / 24.04. No Docker required.

---

## 1. Install system packages

```bash
sudo apt-get update
sudo apt-get install -y python3.11 python3.11-venv python3-pip freecad xvfb
```

**Ubuntu 22.04** ships FreeCAD 0.20.1.
**Ubuntu 24.04** ships FreeCAD 0.21.2.

For a newer build on 22.04, add the FreeCAD PPA first:

```bash
sudo add-apt-repository ppa:freecad-maintainers/freecad-stable
sudo apt-get update && sudo apt-get install -y freecad
```

---

## 2. Verify FreeCAD headless works

```bash
FREECAD_CONSOLE_MODE=1 freecadcmd --version

# Smoke test — all three lines must print "ok"
FREECAD_CONSOLE_MODE=1 freecadcmd - <<'EOF'
import Part, Mesh, MeshPart
print("Part:", "ok")
print("Mesh:", "ok")
print("MeshPart:", "ok")
import sys; sys.exit(0)
EOF
```

---

## 3. AppImage alternative (skip if apt install worked above)

Use this if the apt FreeCAD is too old or you need a specific version.
Most VPS providers do not have FUSE — always extract the AppImage.

```bash
wget -q https://github.com/FreeCAD/FreeCAD/releases/download/0.21.2/FreeCAD_0.21.2-Linux-x86_64.AppImage \
    -O /opt/FreeCAD.AppImage
chmod +x /opt/FreeCAD.AppImage
cd /opt && /opt/FreeCAD.AppImage --appimage-extract
# Binary is now at: /opt/squashfs-root/usr/bin/FreeCADCmd

# Update your .env:
# FREECADCMD_PATH=/opt/squashfs-root/usr/bin/FreeCADCmd
```

---

## 4. Create service user and directories

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin step2stl
sudo mkdir -p /opt/step2stl /var/log/step2stl
sudo chown step2stl:step2stl /opt/step2stl /var/log/step2stl
sudo chmod 750 /opt/step2stl /var/log/step2stl
```

---

## 5. Deploy files

```bash
# Copy the four Python/config files
sudo cp app.py freecad_convert.py config.py requirements.txt /opt/step2stl/

# Copy env template and fill in values
sudo cp .env.example /opt/step2stl/.env
sudo chown step2stl:step2stl /opt/step2stl/.env
sudo chmod 600 /opt/step2stl/.env
sudo nano /opt/step2stl/.env
```

---

## 6. Create virtual environment and install dependencies

```bash
sudo -u step2stl python3.11 -m venv /opt/step2stl/venv
sudo -u step2stl /opt/step2stl/venv/bin/pip install --upgrade pip
sudo -u step2stl /opt/step2stl/venv/bin/pip install -r /opt/step2stl/requirements.txt
```

---

## 7. Install and start the systemd service

```bash
sudo cp step2stl.service /etc/systemd/system/step2stl.service
sudo systemctl daemon-reload
sudo systemctl enable --now step2stl
sudo systemctl status step2stl
```

Check logs:

```bash
sudo journalctl -u step2stl -f
```

---

## 8. (Optional) Nginx reverse proxy

```nginx
upstream step2stl {
    server 127.0.0.1:8001;
    keepalive 4;
}

server {
    listen 443 ssl http2;
    server_name step2stl.yourdomain.com;

    # TLS — use certbot / Let's Encrypt
    ssl_certificate     /etc/letsencrypt/live/step2stl.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/step2stl.yourdomain.com/privkey.pem;

    # Slightly above MAX_FILE_SIZE
    client_max_body_size 55m;

    location / {
        proxy_pass         http://step2stl;
        proxy_read_timeout 90s;   # slightly above TIMEOUT_SECONDS
        proxy_send_timeout 30s;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_request_buffering on;
    }
}
```

---

## 9. Test

```bash
# Health check
curl http://localhost:8001/health | python3 -m json.tool

# Convert a STEP file — writes output to part.stl
curl -X POST http://localhost:8001/convert \
  -F "file=@/path/to/part.step" \
  -o part.stl \
  --max-time 120 \
  -w "HTTP %{http_code}  %{size_download} bytes  %{time_total}s\n"

# Verify the output is a valid STL
file part.stl   # "data" = binary STL, "ASCII text" = ASCII STL

# Error: wrong extension
curl -X POST http://localhost:8001/convert -F "file=@part.obj" -v
# Expected: HTTP 400

# Error: file renamed to .step but not actually STEP
curl -X POST http://localhost:8001/convert \
  -F "file=@image.png;filename=fake.step" -v
# Expected: HTTP 415

# Error: file too large (create a 60 MB dummy)
dd if=/dev/zero bs=1M count=60 | \
  curl -X POST http://localhost:8001/convert \
  -F "file=@-;filename=big.step" -v
# Expected: HTTP 413
```

---

## Updating the service

```bash
sudo cp app.py freecad_convert.py config.py /opt/step2stl/
sudo systemctl restart step2stl
sudo systemctl status step2stl
```

---

## Mesh quality tuning

| Use case | `LINEAR_DEFLECTION` | `ANGULAR_DEFLECTION` | Result |
|----------|--------------------|--------------------|--------|
| Slicing preview | `0.2` | `1.0` | Coarser, fast |
| Default / balanced | `0.1` | `0.5` | Good quality |
| High-fidelity | `0.05` | `0.3` | Fine, slower |

Lower values produce more facets and larger STL files, but improve accuracy
for curved surfaces. Adjust in `.env` and `systemctl restart step2stl`.
