# Deploy local na VPS

## Paper supervisionado via systemd --user

Arquivos:
- `scripts/run_vps_paper.sh`
- `deploy/systemd/btc-polymkt-paper.service`

Instalação:

```bash
chmod +x /home/hermes/projects/BTC_polymkt/scripts/run_vps_paper.sh
mkdir -p ~/.config/systemd/user
cp /home/hermes/projects/BTC_polymkt/deploy/systemd/btc-polymkt-paper.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now btc-polymkt-paper.service
```

Verificações:

```bash
systemctl --user status btc-polymkt-paper.service --no-pager
journalctl --user -u btc-polymkt-paper.service -n 50 --no-pager
ss -ltnp | grep ':9090'
curl -s http://127.0.0.1:9090/api/status
```

## Segurança do dashboard

Padrão seguro:
- `DASHBOARD_HOST=127.0.0.1`
- sem exposição pública
- sem credencial hardcoded

Se quiser expor fora do host, defina também:

```bash
DASHBOARD_BASIC_AUTH_USER=...
DASHBOARD_BASIC_AUTH_PASSWORD=...
DASHBOARD_HOST=0.0.0.0
```

Sem auth explícita, o processo agora falha ao tentar subir dashboard em host não local.
