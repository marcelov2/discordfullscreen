# TRANSPORTE Fullscreen + AC3/E-AC3 + RTC

Instalador independente para habilitar tela cheia real, áudio AC3/E-AC3 e compartilhamento RTC na Activity do TRANSPORTE no Discord Desktop para Windows.

O script baixa a build personalizada baseada no Electron 42.11.11, valida o SHA-256 antes de instalar, guarda os binários originais e configura o reparo automático.

## Instalação

Abra o PowerShell e execute:

```powershell
iwr -useb "https://raw.githubusercontent.com/marcelov2/discordfullscreen/main/install-onefile.ps1" | iex
```

O instalador fecha o Discord, baixa aproximadamente 150 MB, instala fullscreen, AC3/E-AC3 e RTC e abre o `Discord.exe` novamente. Não é necessário baixar o ZIP manualmente.

O `app.ico` da versão instalada do Discord é preservado na janela, na barra de tarefas, nos atalhos e no mixer de volume, mesmo usando o runtime personalizado do Electron. O instalador também aplica o nome interno `Discord`, configura o AppUserModelID correto e renova o cache de ícones do Windows. Se o ícone original não existir, o instalador usa o executável oficial como fallback.
O arquivo copiado recebe um nome associado à versão instalada (`discord-app-*.ico`) para impedir que o cache de ícones do Windows continue mostrando uma imagem antiga.

Depois, entre na Activity do TRANSPORTE e use o botão de tela cheia do player.

> O Krisp oficial não funciona em executáveis sem a assinatura digital da Discord. Nas configurações de voz, use a supressão de ruído **Padrão**.

Uma atualização do Discord pode criar outra pasta `app-*`. O reparo automático reaplica o runtime, a identidade Discord e o fullscreen na versão mais recente.

## Desinstalação

Feche o Discord e execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\TransporteFullscreenPatch\uninstall.ps1"
```

O desinstalador remove o fullscreen e restaura os binários oficiais guardados no backup.
