# Harbor Fullscreen Patch

Patch independente para permitir que uma Discord Activity solicite fullscreen real no Discord Desktop.

## O que ele faz

- preserva o `resources/app.asar` original como `resources/_app.asar`;
- carrega um bootstrap mínimo antes do Discord;
- adiciona a permissão `fullscreen` somente aos iframes `*.discordsays.com`;
- reaplica o carregador quando o Discord baixa uma nova pasta `app-*`;
- executa uma verificação silenciosa no próximo login do Windows;
- não depende de Vencord ou BetterDiscord.

## Instalação

Feche totalmente o Discord e execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Também existe um instalador independente que contém todos os componentes em um único arquivo:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-onefile.ps1
```

Depois que `install-onefile.ps1` for publicado em uma URL HTTPS, ele pode ser executado sem download manual:

```powershell
iwr -useb https://raw.githubusercontent.com/USUARIO/REPOSITORIO/main/install-onefile.ps1 | iex
```

O arquivo único é gerado novamente após mudanças nos componentes com `node build-onefile.mjs`.

Depois abra o Discord, entre na Activity do Harbor e use o botão de tela cheia do player.

## Verificação

No console da janela principal do Discord, `window.__harborFullscreenPatch` deve existir. O campo
`patchedFrames` aumenta quando uma Activity do Discord é detectada.

## Remoção

Feche totalmente o Discord e execute:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:APPDATA\HarborFullscreenPatch\uninstall.ps1"
```

O desinstalador só restaura versões cujo carregador contém o marcador deste patch. Outros modificadores
não são alterados.
