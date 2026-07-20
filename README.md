# Discord Activity Fullscreen

Patch independente que permite usar tela cheia nas Activities do Discord Desktop.

Ele apenas concede a permissao `fullscreen` ao iframe da Activity. Nao adiciona codecs, WebRTC, controles, janelas externas nem modifica o funcionamento das Activities.

Nao depende de Vencord ou BetterDiscord e reaplica o patch quando o Discord recebe uma atualizacao.

## Instalacao

Abra o PowerShell e execute:

```powershell
iwr -useb "https://raw.githubusercontent.com/marcelov2/discordfullscreen/refs/heads/main/install-onefile.ps1" | iex
```

O instalador fecha o Discord, instala a permissao de tela cheia e abre o Discord novamente.

## Desinstalacao

Feche o Discord e execute:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\HarborFullscreenPatch\uninstall.ps1"
```

Depois da desinstalacao, abra o Discord normalmente.
