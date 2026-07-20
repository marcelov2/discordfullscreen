# Discord Activity Fullscreen

O patch tambem oferece MPV embutido na janela do Discord. Nesse modo, play, pausa e busca continuam ligados aos controles do Together, sem abrir uma janela separada. Instale `mpv.exe` no `PATH`, em `C:\mpv` ou `C:\mvp`, pelo Scoop, ou defina `HARBOR_MPV_PATH`.

Patch independente que permite usar tela cheia nas Activities do Discord Desktop e oferece uma ponte opcional para abrir no VLC streams sem áudio compatível no navegador.

Ele concede a permissao `fullscreen` ao iframe da Activity. Na Activity do TRANSPORTE, também permite abrir no VLC uma URL HTTP/HTTPS quando o player detectar áudio incompatível. A ponte não executa comandos de shell e não é exposta a outras Activities.

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
