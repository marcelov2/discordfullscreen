# TRANSPORTE Fullscreen + AC3/E-AC3

Instalador independente para habilitar tela cheia real e áudio AC3/E-AC3 na Activity do TRANSPORTE no Discord Desktop para Windows.

O script baixa a build personalizada do Electron 37.6.0, valida o SHA-256 antes de instalar, guarda os binários originais e configura o reparo automático do fullscreen.

## Instalação

Abra o PowerShell e execute:

```powershell
iwr -useb "https://raw.githubusercontent.com/marcelov2/discordfullscreen/refs/heads/main/install-onefile.ps1" | iex
```

O instalador fecha o Discord, baixa aproximadamente 121 MB, instala fullscreen e AC3/E-AC3 e abre o Discord novamente. Não é necessário baixar o ZIP manualmente.

Depois, entre na Activity do TRANSPORTE e use o botão de tela cheia do player.

> O Krisp oficial não funciona em executáveis sem a assinatura digital da Discord. Nas configurações de voz, use a supressão de ruído **Padrão**.

Uma atualização do Discord pode criar outra pasta `app-*`. O reparo automático mantém o fullscreen, mas uma nova versão do runtime AC3 deve ser publicada antes de substituir os binários de outra versão do Discord.

## Desinstalação

Feche o Discord e execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\TransporteFullscreenPatch\uninstall.ps1"
```

O desinstalador remove o fullscreen e restaura os binários oficiais guardados no backup.
