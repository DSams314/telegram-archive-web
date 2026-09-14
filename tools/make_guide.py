#!/usr/bin/env python3
"""Build the Telegram Archive installation guide as a PDF."""

import re
import subprocess
import tempfile
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, KeepTogether, ListFlowable, ListItem,
    NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer, Table,
    TableStyle,
)

APP = Path(__file__).resolve().parent.parent

# One source of truth for the version, shared with the app itself.
VERSION = re.search(
    r"VERSION = '([^']+)'", (APP / "app" / "version.js").read_text()).group(1)
OUT = APP / "dist" / "Telegram Archive - Install Guide.pdf"

INK      = colors.HexColor("#1a1d23")
MUTED    = colors.HexColor("#5b6472")
ACCENT   = colors.HexColor("#7b5ea7")
WARM     = colors.HexColor("#c9743f")
RULE     = colors.HexColor("#dfe3ea")
PANEL    = colors.HexColor("#f5f2f8")
CODEBG   = colors.HexColor("#f0f2f5")

styles = getSampleStyleSheet()


def S(name, **kw):
    base = kw.pop("parent", styles["BodyText"])
    return ParagraphStyle(name, parent=base, **kw)


BODY = S("body", fontName="Helvetica", fontSize=10.2, leading=15.2,
         textColor=INK, spaceAfter=8, alignment=TA_LEFT)
LEAD = S("lead", parent=BODY, fontSize=11.4, leading=17, textColor=MUTED,
         spaceAfter=13)
H1 = S("h1", fontName="Helvetica-Bold", fontSize=21, leading=25, textColor=INK,
       spaceBefore=0, spaceAfter=4)
H2 = S("h2", fontName="Helvetica-Bold", fontSize=14.5, leading=19,
       textColor=INK, spaceBefore=17, spaceAfter=7)
H3 = S("h3", fontName="Helvetica-Bold", fontSize=11.2, leading=15,
       textColor=ACCENT, spaceBefore=12, spaceAfter=4)
STEP = S("step", parent=BODY, spaceAfter=5)
SMALL = S("small", parent=BODY, fontSize=8.9, leading=12.6, textColor=MUTED)
CODE = S("code", fontName="Courier", fontSize=8.9, leading=13,
         textColor=colors.HexColor("#333a45"), backColor=CODEBG,
         borderPadding=(7, 8, 7, 8), spaceBefore=4, spaceAfter=9,
         leftIndent=2)
NOTE = S("note", parent=BODY, fontSize=9.6, leading=14, spaceAfter=0)


def logo_png(size=150):
    """Rasterise the app's own vector mark, so the guide matches the program."""
    source = (APP / "app" / "logo.js").read_text()
    marks = re.search(r"export const LOGO_MARKS = `(.*?)`;", source, re.S).group(1)
    svg = f'''<svg viewBox="0 0 124 124" width="{size}" height="{size}"
      xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#b9a3e3"/>
        <stop offset="0.45" stop-color="#d9b6d2"/>
        <stop offset="1" stop-color="#efb183"/></linearGradient></defs>
      <rect x="2" y="2" width="120" height="120" rx="30" fill="url(#g)"/>
      <g color="#fdf6e3">{marks}</g></svg>'''
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "logo.svg"
    src.write_text(svg)
    subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", str(tmp), str(src)],
                   capture_output=True)
    png = tmp / "logo.svg.png"
    return png if png.exists() else None


def rule(space_before=2, space_after=9):
    t = Table([[""]], colWidths=[6.6 * inch], rowHeights=[0.5])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.6, RULE)]))
    return [Spacer(1, space_before), t, Spacer(1, space_after)]


def panel(title, lines, bg=PANEL, edge=ACCENT):
    """A callout box that never splits across a page."""
    inner = [Paragraph(f"<b>{title}</b>", S("pt", parent=BODY, fontSize=10.4,
                                            textColor=edge, spaceAfter=4))]
    for line in lines:
        inner.append(Paragraph(line, NOTE))
        inner.append(Spacer(1, 3))
    t = Table([[inner]], colWidths=[6.6 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 13),
        ("RIGHTPADDING", (0, 0), (-1, -1), 13),
        ("TOPPADDING", (0, 0), (-1, -1), 11),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, edge),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return KeepTogether([t, Spacer(1, 11)])


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(text, STEP), leftIndent=20, value=i)
         for i, text in enumerate(items, start=1)],
        bulletType="1", bulletFontName="Helvetica-Bold", bulletFontSize=10,
        bulletColor=ACCENT, leftIndent=17, spaceAfter=8,
    )


def code(text):
    return Paragraph(text.replace(" ", "&nbsp;").replace("\n", "<br/>"), CODE)


def folder_tree():
    rows = [
        ["Telegram Archive", "the one folder, in your Home folder"],
        ["\u00a0\u00a0\u00a0Backups", "put your chat exports in here"],
        ["\u00a0\u00a0\u00a0Telegram Archive.app", "double-click to start (macOS)"],
        ["\u00a0\u00a0\u00a0data", "created for you; index and settings"],
        ["\u00a0\u00a0\u00a0everything else", "the program; leave it alone"],
    ]
    data = [[Paragraph(f'<font face="Courier">{a}</font>', SMALL),
             Paragraph(b, SMALL)] for a, b in rows]
    t = Table(data, colWidths=[2.5 * inch, 4.1 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("TEXTCOLOR", (1, 0), (1, -1), MUTED),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return KeepTogether([t, Spacer(1, 11)])


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(OUT), pagesize=LETTER,
        leftMargin=0.95 * inch, rightMargin=0.95 * inch,
        topMargin=0.85 * inch, bottomMargin=0.85 * inch,
        title="Telegram Archive - Install Guide",
        author="Telegram Archive", subject="Installation instructions",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="main", leftPadding=0, rightPadding=0,
                  topPadding=0, bottomPadding=0)

    def furniture(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(doc.leftMargin, 0.55 * inch, f"Telegram Archive {VERSION}")
        canvas.drawRightString(LETTER[0] - doc.rightMargin, 0.55 * inch,
                               f"Page {d.page}")
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, 0.72 * inch,
                    LETTER[0] - doc.rightMargin, 0.72 * inch)
        canvas.restoreState()

    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame]),
        PageTemplate(id="body", frames=[frame], onPage=furniture),
    ])

    s = []

    # ---------------- cover ----------------
    s.append(Spacer(1, 1.5 * inch))
    png = logo_png(150)
    if png:
        img = Image(str(png), width=1.15 * inch, height=1.15 * inch)
        img.hAlign = "LEFT"
        s.append(img)
        s.append(Spacer(1, 20))
    s.append(Paragraph("Telegram Archive", S("cover", parent=H1, fontSize=31,
                                             leading=35, spaceAfter=6)))
    s.append(Paragraph("Installation guide &mdash; macOS, Windows and Linux",
                       S("sub", parent=LEAD, fontSize=13, textColor=MUTED,
                         spaceAfter=22)))
    s.append(Paragraph(
        "A private reader for your Telegram chat exports. It runs entirely on "
        "your own computer: nothing is uploaded, nothing is tracked, and your "
        "exports are only ever read, never changed.", LEAD))
    s.extend(rule(6, 12))
    s.append(Paragraph(
        "<b>You need one thing first:</b> Python 3. macOS and Linux already "
        "have it. On Windows it is a free two-minute install and this guide "
        "shows you exactly how.", BODY))
    s.append(Spacer(1, 8))
    s.append(Paragraph(
        "Installing takes about a minute. Everything lands in a single folder "
        "called <font face=\"Courier\">Telegram Archive</font> inside your Home "
        "folder, so there is one place to find, move, back up or delete.", BODY))
    s.append(NextPageTemplate("body"))
    s.append(PageBreak())

    # ---------------- before you start ----------------
    s.append(Paragraph("Before you start", H1))
    s.extend(rule())
    s.append(Paragraph("1. Export your chats from Telegram", H2))
    s.append(Paragraph(
        "In <b>Telegram Desktop</b> (not the phone app), open "
        "<b>Settings &rsaquo; Advanced &rsaquo; Export Telegram data</b>.", BODY))
    s.append(steps([
        "Tick the chats you want, and tick the media types you want to keep "
        "(photos, videos, voice messages, stickers, files).",
        "Set <b>Format</b> to <b>Machine-readable JSON</b>. This matters &mdash; "
        "see the note below.",
        "Choose where to save it and start the export. A large archive can take "
        "hours, so leave it running.",
    ]))
    s.append(panel("Choose JSON, not HTML", [
        "The HTML option makes a version for a web browser. It leaves out the "
        "image dimensions, who reacted to what, and who sent each message, and "
        "Telegram Archive needs those.",
        "If you already have an HTML export, keep it. Run a new JSON export "
        "into a <b>separate, empty folder</b> next to it and put both in "
        "<font face=\"Courier\">Backups</font>. The program reads the structure "
        "from the JSON and can still find media through the old HTML export, so "
        "nothing has to be downloaded twice.",
    ]))

    s.append(Paragraph("2. Check you have Python 3", H2))
    s.append(Paragraph(
        "<b>macOS and Linux:</b> you already do. Skip ahead.", BODY))
    s.append(Paragraph(
        "<b>Windows:</b> go to <font face=\"Courier\">python.org/downloads</font>, "
        "download Python 3, and run the installer. On the very first screen, "
        "tick <b>Add python.exe to PATH</b> before clicking Install Now. If you "
        "miss that tick box, the installer will not be able to find Python.",
        BODY))
    s.append(Spacer(1, 4))

    # ---------------- install ----------------
    s.append(KeepTogether([
        Paragraph("Installing", H1), *rule(),
        Paragraph(
        f"Start by unzipping <font face=\"Courier\">TelegramArchive-{VERSION}"
        ".zip</font>. Your Downloads folder is fine &mdash; the installer moves "
        "everything where it needs to go and then removes the unzipped folder "
        "for you, so there is nothing to clear up afterwards. Keep the .zip if "
        "you want to install on another computer later.",
        BODY)]))

    s.append(Paragraph("macOS", H3))
    s.append(steps([
        "Open the unzipped folder and double-click "
        "<b>Install (macOS).command</b>.",
        "macOS will probably say it &ldquo;cannot be opened because it is from "
        "an unidentified developer&rdquo;. Click <b>OK</b>, then "
        "<b>right-click</b> the same file and choose <b>Open</b>, then "
        "<b>Open</b> again. You only do this once.",
        "A black Terminal window appears and runs the install. When it says "
        "<i>Installed</i>, press Return to close it.",
        "Drag <b>Telegram Archive.app</b> from the new folder onto your Dock so "
        "it is easy to find.",
    ]))

    s.append(Paragraph("Windows", H3))
    s.append(steps([
        "Open the unzipped folder and double-click "
        "<b>Install (Windows).bat</b>.",
        "Windows may show a blue &ldquo;Windows protected your PC&rdquo; box. "
        "Click <b>More info</b>, then <b>Run anyway</b>.",
        "A black window appears and runs the install. Press a key to close it "
        "when it finishes.",
        "Telegram Archive is now in your <b>Start Menu</b>.",
    ]))

    s.append(Paragraph("Linux", H3))
    s.append(steps([
        "Open a terminal in the unzipped folder.",
        "Run the installer:",
    ]))
    s.append(code("./'Install (Linux).sh'"))
    s.append(Paragraph(
        "If it refuses to run, make it executable first with "
        "<font face=\"Courier\">chmod +x 'Install (Linux).sh'</font>. "
        "Telegram Archive then appears in your applications menu.", BODY))
    s.append(PageBreak())

    # ---------------- where things go ----------------
    s.append(KeepTogether([
        Paragraph("Where everything goes", H1), *rule(),
        Paragraph(
            "Everything lives in one folder called "
            "<font face=\"Courier\">Telegram Archive</font>, inside your Home "
            "folder. Not Documents, not Desktop &mdash; your Home folder itself.",
            BODY),
    ]))
    s.append(Spacer(1, 6))
    s.append(folder_tree())

    t = Table([
        [Paragraph("<b>System</b>", SMALL), Paragraph("<b>Full path</b>", SMALL)],
        [Paragraph("macOS", SMALL),
         Paragraph('<font face="Courier">/Users/&lt;you&gt;/Telegram Archive</font>', SMALL)],
        [Paragraph("Windows", SMALL),
         Paragraph('<font face="Courier">C:\\Users\\&lt;you&gt;\\Telegram Archive</font>', SMALL)],
        [Paragraph("Linux", SMALL),
         Paragraph('<font face="Courier">/home/&lt;you&gt;/Telegram Archive</font>', SMALL)],
    ], colWidths=[1.3 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    s.append(t)
    s.append(Spacer(1, 14))

    s.append(panel("Where to put your chat exports", [
        "Put them in the <font face=\"Courier\">Backups</font> folder that the "
        "installer created for you. There is a text file inside it with a "
        "reminder of the layout.",
        "Make <b>one folder per person or group</b>, and put that "
        "conversation's export folder inside it:",
        "<font face=\"Courier\">Backups / Mum / ChatExport_2026_03_01 / "
        "result.json</font>",
        "You can also just drag a whole <font face=\"Courier\">ChatExport</font> "
        "folder straight into <font face=\"Courier\">Backups</font> on its own "
        "&mdash; that works too.",
        "If one conversation has several exports from different dates, put them "
        "all in that person's folder. They get merged into a single history "
        "with no duplicates.",
    ]))

    s.append(panel("macOS: do not use Documents, Desktop or Downloads", [
        "macOS blocks apps from reading those three folders unless the app was "
        "signed by a paid Apple developer account, and it blocks them "
        "<b>silently</b> &mdash; the app looks like it simply found nothing.",
        "This is exactly why the installer uses your Home folder instead. As "
        "long as you keep your exports in "
        "<font face=\"Courier\">Telegram Archive / Backups</font>, you will "
        "never run into it.",
        "If you keep your exports somewhere else and the app shows no chats, "
        "that restriction is almost certainly why. Either move them into "
        "<font face=\"Courier\">Backups</font>, or open <b>System Settings "
        "&rsaquo; Privacy &amp; Security &rsaquo; Files and Folders</b> and "
        "give Telegram Archive access.",
    ], bg=colors.HexColor("#fdf3ec"), edge=WARM))

    # ---------------- first run ----------------
    s.append(KeepTogether([
        Paragraph("Starting it for the first time", H1), *rule()]))
    t = Table([
        [Paragraph("<b>macOS</b>", SMALL),
         Paragraph("Double-click <b>Telegram Archive.app</b>, or click it in "
                   "your Dock.", SMALL)],
        [Paragraph("<b>Windows</b>", SMALL),
         Paragraph("Open <b>Telegram Archive</b> from the Start Menu.", SMALL)],
        [Paragraph("<b>Linux</b>", SMALL),
         Paragraph("Open <b>Telegram Archive</b> from your applications menu.",
                   SMALL)],
    ], colWidths=[1.3 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    s.append(t)
    s.append(Spacer(1, 12))
    s.append(Paragraph(
        "Telegram Archive opens in your web browser. That is normal &mdash; the "
        "browser is just the window. Nothing is on the internet, and the address "
        "<font face=\"Courier\">127.0.0.1</font> means &ldquo;this computer, and "
        "only this computer&rdquo;.", BODY))
    s.append(Spacer(1, 6))
    s.append(Paragraph("The four setup steps", H2))
    s.append(steps([
        "<b>Welcome.</b> Click Continue.",
        "<b>Where are your exports?</b> It already points at your "
        "<font face=\"Courier\">Backups</font> folder. Folders that contain "
        "exports are marked. Click Continue and it reads your archive &mdash; "
        "a big one can take a minute.",
        "<b>Which one is you?</b> It works this out for you (you are the one "
        "person in every conversation) and preselects you. Correct it if it is "
        "wrong, add your name, and optionally choose a photo.",
        "<b>All set.</b> Click <b>Let's go</b>.",
    ]))
    s.append(Paragraph(
        "Setup only happens once. To run it again: <b>Settings &rsaquo; Archive "
        "&rsaquo; Run first-time setup again</b>.", BODY))

    s.append(Paragraph("Everyday use", H2))
    s.append(Paragraph(
        "<b>To stop it:</b> click the power button at the bottom-left and "
        "confirm. Closing the browser tab is not enough &mdash; the program "
        "keeps running behind it, which is what that button is for.", BODY))
    s.append(Paragraph(
        "<b>After adding new exports:</b> drop them into "
        "<font face=\"Courier\">Backups</font>, then open <b>Settings &rsaquo; "
        "Archive &rsaquo; Rebuild the index</b>.", BODY))
    s.append(Paragraph(
        "<b>To move or back up everything:</b> copy the whole "
        "<font face=\"Courier\">Telegram Archive</font> folder. It is entirely "
        "self-contained.", BODY))
    s.append(Paragraph(
        "<b>To uninstall:</b> see the next section.", BODY))

    # ---------------- uninstalling ----------------
    s.append(KeepTogether([
        Paragraph("Uninstalling", H1), *rule(),
        Paragraph(
            "Double-click the uninstaller in your "
            "<font face=\"Courier\">Telegram Archive</font> folder:", BODY)]))
    t = Table([
        [Paragraph("<b>macOS</b>", SMALL),
         Paragraph("<b>Uninstall (macOS).command</b>", SMALL)],
        [Paragraph("<b>Windows</b>", SMALL),
         Paragraph("<b>Uninstall (Windows).bat</b>", SMALL)],
        [Paragraph("<b>Linux</b>", SMALL),
         Paragraph("<b>Uninstall (Linux).sh</b>", SMALL)],
    ], colWidths=[1.3 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    s.append(t)
    s.append(Spacer(1, 11))
    s.append(Paragraph(
        "It shows you what it is about to do and asks before doing anything. "
        "It stops the program if it is running, removes the program and its "
        "index, and deletes the Start Menu or applications-menu entry.", BODY))

    s.append(panel("Your chat exports are kept", [
        "The uninstaller <b>never deletes your "
        "<font face=\"Courier\">Backups</font> folder</b>. It leaves it exactly "
        "where it is, with every file byte-for-byte as Telegram exported it.",
        "That is not just a promise about the uninstaller. Telegram Archive "
        "only ever <b>reads</b> your exports &mdash; it has no ability to write "
        "to that folder at all, so nothing it does can alter or corrupt them.",
        "When it finishes it tells you where your exports are and how large "
        "they are. Move that folder anywhere you like, or delete it yourself "
        "when you genuinely want it gone.",
        "If you never added any exports, the whole folder is removed and "
        "nothing is left behind.",
    ]))
    s.append(Paragraph(
        "Nothing is installed anywhere else. No system files are changed, "
        "nothing is added to startup, and no administrator rights were ever "
        "used &mdash; so there is nothing else to clean up.", BODY))
    s.append(Spacer(1, 4))
    s.append(Paragraph("Removing it by hand instead", H3))
    s.append(Paragraph(
        "You can simply delete the <font face=\"Courier\">Telegram Archive</font> "
        "folder &mdash; but <b>move the <font face=\"Courier\">Backups</font> "
        "folder out of it first</b>, or you will delete your exports along with "
        "the program.", BODY))

    # ---------------- updating ----------------
    s.append(KeepTogether([
        Paragraph("Installing a newer version", H1), *rule()]))
    s.append(Paragraph(
        "Unzip the new version and run its installer exactly as before. It "
        "notices the copy you already have and asks what to do:", BODY))
    s.append(steps([
        "<b>Update it</b> &mdash; replaces the program, keeps your settings, "
        "your pictures and your <font face=\"Courier\">Backups</font> folder. "
        "This is what you normally want.",
        "<b>Keep both</b> &mdash; installs the new version in a folder of its "
        "own, next to the old one, and leaves the old one working. Both read "
        "the <i>same</i> exports, so nothing is copied and you do not end up "
        "with two archives to keep in step.",
        "<b>Cancel</b> &mdash; changes nothing at all.",
    ]))
    s.append(panel("Your exports are safe in every case", [
        "None of the three options move, rewrite or delete anything in "
        "<font face=\"Courier\">Backups</font>. The program only ever reads "
        "your exports &mdash; installing, updating and uninstalling included.",
    ]))

    # ---------------- troubleshooting ----------------
    s.append(KeepTogether([
        Paragraph("If something goes wrong", H1), *rule()]))

    faq = [
        ("Nothing happens when I open it",
         "Give it a few seconds &mdash; it reads your archive before the window "
         "appears. If the browser still does not open, go to "
         "<font face=\"Courier\">http://127.0.0.1:8730</font> yourself. On macOS, "
         "try <b>Start Viewer.command</b> in the Telegram Archive folder, which "
         "shows any error in a Terminal window."),
        ("It says Python is required",
         "Install Python 3 from <font face=\"Courier\">python.org/downloads</font> "
         "and run the installer again. On Windows, make sure you tick <b>Add "
         "python.exe to PATH</b> on the first screen of the Python installer."),
        ("macOS will not let me open the installer",
         "Right-click it and choose <b>Open</b>, then <b>Open</b> again. That "
         "tells macOS you trust it. This is normal for any app not sold through "
         "the App Store."),
        ("It opens but shows no chats",
         "Check that your exports are inside the <font face=\"Courier\">Backups"
         "</font> folder, each in a folder of its own, and that each export "
         "contains a <font face=\"Courier\">result.json</font>. Then use "
         "<b>Settings &rsaquo; Archive &rsaquo; Rebuild the index</b>. On macOS, "
         "if your exports are in Documents, Desktop or Downloads, move them into "
         "<font face=\"Courier\">Backups</font>."),
        ("My exports are in Synology Drive, iCloud, Dropbox or OneDrive",
         "Folders under <font face=\"Courier\">Library/CloudStorage</font> are "
         "held behind a permission of their own that no Files-and-Folders "
         "switch covers, so Telegram Archive will never appear there for one. "
         "Best fix: if it is a NAS, connect to it directly &mdash; Finder "
         "<b>Go &rsaquo; Connect to Server</b>, <font face=\"Courier\">smb://"
         "your-nas</font> &mdash; and point at the share under "
         "<font face=\"Courier\">/Volumes</font>. Otherwise have the sync app "
         "keep a real local copy (not on-demand or online-only) and use that "
         "folder, or grant Full Disk Access."),
        ("How do I point it at a different folder?",
         "<b>Settings &rsaquo; Archive &rsaquo; Backup folder</b>, then "
         "<b>Browse&hellip;</b>, which opens your system's own folder chooser. "
         "Then <b>Rebuild the index</b>. If the new folder has no exports in it yet, that is fine: "
         "you get an empty archive rather than an error, and the old chats are "
         "cleared out so nothing stale is left behind."),
        ("Is my backup drive plugged in?",
         "<b>Settings &rsaquo; Archive &rsaquo; Storage</b> says which kind of "
         "disk your exports are on &mdash; this computer, an external drive or "
         "a network drive &mdash; and whether it is connected right now."),
        ("My exports are on an external or network drive and it cannot read them",
         "macOS keeps external drives behind their own permission switch, "
         "separate from the one for Documents and Desktop. Open <b>System "
         "Settings &rsaquo; Privacy &amp; Security &rsaquo; Files and Folders</b>, "
         "find <b>Telegram Archive</b>, and switch on <b>Removable Volumes</b>. "
         "If it is not listed there, use <b>Full Disk Access</b> instead and add "
         "it with the <b>+</b> button. Opening <b>Start Viewer.command</b> also "
         "works, because Terminal already has access. Whichever you choose, the "
         "drive has to be plugged in and mounted, and the path in <b>Settings "
         "&rsaquo; Archive &rsaquo; Backup folder</b> has to be the full one, "
         "starting with <font face=\"Courier\">/Volumes/</font>."),
        ("Photos and videos show a shimmering box",
         "That means the file was not included in the export. Export again from "
         "Telegram with the media types ticked. The box is the exact shape the "
         "missing picture was, so the layout still reads correctly."),
        ("Some messages say the file is missing but I know I have it",
         "An interrupted export sometimes writes &ldquo;file not included&rdquo; "
         "even though the file is there. Telegram Archive matches those up by "
         "file size and dimensions automatically, so try <b>Rebuild the index</b> "
         "&mdash; the report will say how many it recovered."),
        ("I uninstalled. Where did my exports go?",
         "Still in <font face=\"Courier\">Telegram Archive / Backups</font>, "
         "untouched. The uninstaller keeps that folder on purpose and prints "
         "its location when it finishes. If the folder is gone entirely, it "
         "was empty &mdash; no exports had been added."),
        ("I want to start completely fresh",
         "<b>Settings &rsaquo; Advanced &rsaquo; Reset everything</b>. That "
         "clears your settings and runs setup again. It never touches your "
         "exports."),
    ]
    for q, a in faq:
        s.append(KeepTogether([
            Paragraph(q, S("q", parent=BODY, fontName="Helvetica-Bold",
                           fontSize=10.4, textColor=INK, spaceAfter=2)),
            Paragraph(a, S("a", parent=BODY, fontSize=9.8, leading=14,
                           textColor=MUTED, spaceAfter=11)),
        ]))

    s.extend(rule(6, 8))
    s.append(Paragraph(
        "<b>A note on privacy.</b> Telegram Archive never connects to the "
        "internet. It has no analytics, no update check and no third-party "
        "code &mdash; only Python's own standard library and your browser. It "
        "reads your exports and never writes to them. Everything it saves lives "
        "in the <font face=\"Courier\">data</font> folder next to the program.",
        SMALL))

    doc.build(s)
    print(f"{OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    build()
