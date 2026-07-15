# TRANSPORTE Fullscreen Patch

Patch independente para permitir que uma Discord Activity use tela cheia real e tente reproduzir áudio AC3/E-AC3 no Discord Desktop.

Não depende de Vencord ou BetterDiscord e continua funcionando após atualizações do Discord.

## Instalação

Abra o PowerShell e execute:

```powershell
iwr -useb "https://raw.githubusercontent.com/marcelov2/discordfullscreen/refs/heads/main/install-onefile.ps1" | iex
```

O instalador fecha o Discord, instala o patch de fullscreen e AC3/E-AC3, abre o Discord novamente e encerra o terminal automaticamente.

Depois, entre na Activity do Harbor e use o botão de tela cheia do player.

## Desinstalação

Feche o Discord e execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\HarborFullscreenPatch\uninstall.ps1"
```

Depois da desinstalação, abra o Discord normalmente.
