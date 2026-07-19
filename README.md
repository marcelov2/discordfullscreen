# Harbor Fullscreen e Together WebRTC Patch

Patch independente para permitir tela cheia, suporte AC3/E-AC3 e uma ponte WebRTC nativa para o modo Harbor Together no Discord Desktop.

O modo Solo não usa a ponte. No Together, clientes sem o patch continuam automaticamente pela transmissão H.264/WebSocket compatível com Activities.

Não depende de Vencord ou BetterDiscord e continua funcionando após atualizações do Discord.

## Instalação

Abra o PowerShell e execute:

```powershell
iwr -useb "https://raw.githubusercontent.com/marcelov2/discordfullscreen/refs/heads/main/install-onefile.ps1" | iex
```

O instalador fecha o Discord, instala o patch de fullscreen, AC3/E-AC3 e Together WebRTC, abre o Discord novamente e encerra o terminal automaticamente.

Depois, entre na Activity do Harbor e use o botão de tela cheia do player.

## Desinstalação

Feche o Discord e execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\HarborFullscreenPatch\uninstall.ps1"
```

Depois da desinstalação, abra o Discord normalmente.
