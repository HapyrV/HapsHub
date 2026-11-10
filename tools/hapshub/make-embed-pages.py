"""Writes the embed pages from one template and adds their translations. Run again after changing either."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGE = """<div class="aemb-page">
    <div class="tab-toolbar">
        <div class="aemb-title"><span class="msi">{icon}</span> <span data-i18n="{nav}">{name}</span></div>
        <div id="aemb-status-{app}" class="aemb-status" role="status"></div>
        <div class="aemb-actions">
            <select id="aemb-mode-{app}" class="vrcn-dropdown" onchange="aembMode('{app}')">
                <option value="child" data-i18n="hub.embed.mode_child">Inside this page</option>
                <option value="tracked" data-i18n="hub.embed.mode_tracked">Its own window over this page</option>
            </select>
            <button id="aemb-start-{app}" class="vrcn-button-round vrcn-btn-join" onclick="aembStart('{app}')"><span class="msi">open_in_new</span> <span data-i18n="hub.embed.open">Open here</span></button>
            <button id="aemb-release-{app}" class="vrcn-button-round" onclick="aembRelease('{app}')" disabled><span class="msi">close</span> <span data-i18n="hub.embed.release">Put it back</span></button>
            <button id="aemb-test-{app}" class="vrcn-button-round" onclick="aembTest('{app}')"><span class="msi">bug_report</span> <span data-i18n="hub.embed.test">Test</span></button>
        </div>
    </div>
    <div id="aemb-pane-{app}" class="aemb-pane">
        <div id="aemb-hint-{app}" class="aemb-hint" data-i18n="hub.embed.hint">Open here shows the app in this space. Put it back returns it to its own window.</div>
    </div>
    <div class="aemb-report"><div id="aemb-result-{app}"></div><div id="aemb-results-{app}"></div></div>
</div>
"""
APPS = [("oyasumi", "OyasumiVR", "bedtime"), ("eagle", "Eagle", "photo_library"), ("spacecal", "Space Calibrator", "gps_fixed"),
        ("ovrtoolkit", "OVR Toolkit", "view_in_ar")]
for app, name, icon in APPS:
    target = ROOT / "frontend/modules/tools/app-embed" / f"{app}.html"
    target.write_text(PAGE.format(app=app, name=name, icon=icon, nav=f"nav.{app}"), encoding="utf-8", newline="\n")

TEXT = {
    "en": ["Open here", "Put it back", "Test", "Inside this page", "Its own window over this page",
           "Open here shows the app in this space. Put it back returns it to its own window.",
           "{app} was not found. Set its path under App embeds in Settings, Hub modules.", "Testing...", "Opening..."],
    "de": ["Hier öffnen", "Zurückgeben", "Testen", "In dieser Seite", "Eigenes Fenster über dieser Seite",
           "„Hier öffnen“ zeigt die App in diesem Bereich. „Zurückgeben“ bringt sie wieder in ihr eigenes Fenster.",
           "{app} wurde nicht gefunden. Lege den Pfad unter App-Einbettungen in Einstellungen, Hub-Module fest.", "Wird getestet...", "Wird geöffnet..."],
    "es": ["Abrir aquí", "Devolver", "Probar", "Dentro de esta página", "Ventana propia sobre esta página",
           "Abrir aquí muestra la aplicación en este espacio. Devolver la regresa a su propia ventana.",
           "No se encontró {app}. Indica su ruta en Inserción de apps, en Ajustes, Módulos de Hub.", "Probando...", "Abriendo..."],
    "fr": ["Ouvrir ici", "Remettre", "Tester", "Dans cette page", "Sa propre fenêtre sur cette page",
           "Ouvrir ici affiche l'application dans cet espace. Remettre la renvoie dans sa propre fenêtre.",
           "{app} est introuvable. Indique son chemin sous Applications intégrées dans Paramètres, Modules Hub.", "Test en cours...", "Ouverture..."],
    "ja": ["ここで開く", "元に戻す", "テスト", "このページの中", "このページの上に別ウィンドウ",
           "「ここで開く」でアプリをこの場所に表示します。「元に戻す」で元のウィンドウに戻します。",
           "{app} が見つかりません。設定の Hub モジュール、アプリ埋め込みでパスを指定してください。", "テスト中...", "開いています..."],
    "ko": ["여기서 열기", "되돌리기", "테스트", "이 페이지 안", "이 페이지 위의 별도 창",
           "여기서 열기는 앱을 이 공간에 표시합니다. 되돌리기는 앱을 원래 창으로 돌려놓습니다.",
           "{app}을(를) 찾을 수 없습니다. 설정, Hub 모듈의 앱 임베드에서 경로를 지정하세요.", "테스트 중...", "여는 중..."],
    "ru": ["Открыть здесь", "Вернуть", "Проверить", "Внутри этой страницы", "Отдельное окно поверх страницы",
           "«Открыть здесь» показывает приложение в этой области. «Вернуть» возвращает его в собственное окно.",
           "{app} не найдено. Укажите путь в разделе «Встроенные приложения»: Настройки, модули Hub.", "Проверка...", "Открытие..."],
    "zh-CN": ["在此打开", "放回去", "测试", "在此页面内", "此页面上方的独立窗口",
              "“在此打开”会在这里显示应用。“放回去”会让它回到自己的窗口。",
              "未找到 {app}。请在“设置”>“Hub 模块”的“应用嵌入”中设置路径。", "正在测试...", "正在打开..."],
    "zh-TW": ["在此開啟", "放回去", "測試", "在此頁面內", "此頁面上方的獨立視窗",
              "「在此開啟」會在這裡顯示應用程式。「放回去」會讓它回到自己的視窗。",
              "找不到 {app}。請在「設定」>「Hub 模組」的「應用程式嵌入」中設定路徑。", "正在測試...", "正在開啟..."],
}
KEYS = ["open", "release", "test", "mode_child", "mode_tracked", "hint", "not_found", "testing", "opening"]

for language, values in TEXT.items():
    path = ROOT / "frontend/i18n" / f"{language}.json"
    raw = path.read_bytes().decode("utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    entries = {f"nav.{app}": name for app, name, _ in APPS}
    entries.update({f"hub.embed.{key}": value for key, value in zip(KEYS, values)})
    existing = json.loads(raw.lstrip(chr(0xFEFF)))
    lines = [f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in entries.items() if k not in existing]
    if not lines:
        continue
    match = re.search(r'"\s*}\s*$', raw)
    closing = raw[match.start() + 1:]
    raw = raw[:match.start() + 1] + "," + newline + ("," + newline).join(lines) + closing
    json.loads(raw.lstrip(chr(0xFEFF)))
    path.write_bytes(raw.encode("utf-8"))
print("ok")
