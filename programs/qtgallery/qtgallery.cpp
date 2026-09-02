/*
 * qtgallery — the Omarchy theme gallery, a Qt application on the desktop.
 *
 * A QRasterWindow painted through QtGui's raster engine onto a wl_shm
 * buffer. Each installed theme (a directory under WLC_THEME_DIR, default
 * /usr/share/kandelo/themes, holding a theme.conf) becomes a card painted
 * as a miniature desktop from its own palette: wallpaper gradient, bar
 * strip, two tiled windows with the active border. Activating a card
 * writes `dispatch theme <name>` to the compositor's kwlctl socket
 * (KWLCTL_SOCKET, default /tmp/kwlctl-0) — the same control surface
 * kwlctl and the CTRL+SHIFT+Space bind use — and the whole desktop
 * repaints from the new palette.
 *
 * A second row lists the Quickshell shells staged under
 * QTGALLERY_SHELL_DIR (default /usr/share/kandelo/quickshell): activating
 * one restarts the gallery's Quickshell child with that QML file, the
 * swap-the-shell demonstration Quickshell exists for.
 *
 * Cards activate by click (hover highlights) or by arrows + Enter.
 * Escape or Q closes.
 *
 * Markers on stdout (the smoke test and the browser spec read them):
 *   GALLERY_PLATFORM=<qpa>            after QGuiApplication construction
 *   GALLERY_THEMES n=<count>          after the theme scan
 *   GALLERY_SHELLS n=<count>          after the shell scan
 *   GALLERY_EXPOSED <w>x<h>           once, on the first paint
 *   GALLERY_APPLY theme=<n> reply=<r> after a theme card activates
 *   GALLERY_SHELL file=<p> pid=<pid>  after a shell card activates
 */
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QLinearGradient>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QProcess>
#include <QRasterWindow>
#include <QTextStream>
#include <QTime>
#include <QTimer>
#include <QtPlugin>

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdio>

Q_IMPORT_PLUGIN(QWaylandIntegrationPlugin)
Q_IMPORT_PLUGIN(QWaylandXdgShellIntegrationPlugin)

namespace {

const QColor kWindow(0x16, 0x16, 0x1e);
const QColor kCard(0x1f, 0x23, 0x35);
const QColor kCardBorder(0x3b, 0x42, 0x61);
const QColor kText(0xc0, 0xca, 0xf5);
const QColor kDimText(0x56, 0x5f, 0x89);
const QColor kAccent(0x7a, 0xa2, 0xf7);

struct Theme {
    QString name;
    QString title;
    QColor wallpaperTop;
    QColor wallpaperBottom;
    QColor bar;
    QColor border;
    QColor occupied;
    QColor foreground;
    QColor accent;
};

QString themesRoot()
{
    const QByteArray env = qgetenv("WLC_THEME_DIR");
    return env.isEmpty() ? QStringLiteral("/usr/share/kandelo/themes")
                         : QString::fromUtf8(env);
}

QString shellsRoot()
{
    const QByteArray env = qgetenv("QTGALLERY_SHELL_DIR");
    return env.isEmpty() ? QStringLiteral("/usr/share/kandelo/quickshell")
                         : QString::fromUtf8(env);
}

QColor parseColor(const QString &value, const QColor &fallback)
{
    QString s = value.trimmed();
    if (s.startsWith('#')) s.remove(0, 1);
    if (s.startsWith(QStringLiteral("0x"))) s.remove(0, 2);
    bool ok = false;
    const uint rgb = s.toUInt(&ok, 16);
    if (!ok) return fallback;
    return QColor::fromRgb(0xff000000u | rgb);
}

QString titleCase(const QString &slug)
{
    QStringList words = slug.split('-', Qt::SkipEmptyParts);
    for (QString &w : words)
        w[0] = w[0].toUpper();
    return words.join(' ');
}

Theme loadTheme(const QString &dir, const QString &name)
{
    Theme t;
    t.name = name;
    t.title = titleCase(name);
    t.wallpaperTop = QColor(0x1a, 0x1b, 0x26);
    t.wallpaperBottom = QColor(0x24, 0x28, 0x3b);
    t.bar = kWindow;
    t.border = kAccent;
    t.occupied = QColor(0x29, 0x2e, 0x42);
    t.foreground = kText;
    t.accent = kAccent;

    QFile f(dir + '/' + name + QStringLiteral("/theme.conf"));
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) return t;
    QTextStream in(&f);
    while (!in.atEnd()) {
        const QString line = in.readLine().trimmed();
        if (line.isEmpty() || line.startsWith('#')) continue;
        const qsizetype eq = line.indexOf('=');
        if (eq < 0) continue;
        const QString key = line.left(eq).trimmed();
        const QString val = line.mid(eq + 1).trimmed();
        if (key == QStringLiteral("wallpaper_top"))
            t.wallpaperTop = parseColor(val, t.wallpaperTop);
        else if (key == QStringLiteral("wallpaper_bottom"))
            t.wallpaperBottom = parseColor(val, t.wallpaperBottom);
        else if (key == QStringLiteral("bar"))
            t.bar = parseColor(val, t.bar);
        else if (key == QStringLiteral("border_active"))
            t.border = parseColor(val, t.border);
        else if (key == QStringLiteral("occupied"))
            t.occupied = parseColor(val, t.occupied);
        else if (key == QStringLiteral("foreground"))
            t.foreground = parseColor(val, t.foreground);
        else if (key == QStringLiteral("accent"))
            t.accent = parseColor(val, t.accent);
    }
    return t;
}

/* One request/reply line on the compositor's control socket, the exact
 * conversation kwlctl.c holds. Returns the trimmed reply ("ok" on
 * success), or an empty string when the socket is unreachable. */
QString kwlctlDispatch(const QString &command)
{
    const QByteArray env = qgetenv("KWLCTL_SOCKET");
    const QByteArray path = env.isEmpty() ? QByteArrayLiteral("/tmp/kwlctl-0")
                                          : env;
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return QString();
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path.constData(), sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return QString();
    }
    const QByteArray line = command.toUtf8() + '\n';
    if (write(fd, line.constData(), (size_t)line.size()) != line.size()) {
        close(fd);
        return QString();
    }
    char buf[256];
    QByteArray reply;
    ssize_t r;
    while ((r = read(fd, buf, sizeof(buf))) > 0)
        reply.append(buf, (qsizetype)r);
    close(fd);
    return QString::fromUtf8(reply).trimmed();
}

} // namespace

class GalleryWindow : public QRasterWindow
{
public:
    GalleryWindow()
    {
        setTitle(QStringLiteral("Theme Gallery"));

        const QDir root(themesRoot());
        for (const QString &entry :
             root.entryList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name)) {
            if (QFile::exists(root.filePath(
                    entry + QStringLiteral("/theme.conf"))))
                m_themes.append(loadTheme(root.absolutePath(), entry));
        }
        std::printf("GALLERY_THEMES n=%d\n", (int)m_themes.size());

        const QDir shells(shellsRoot());
        for (const QString &entry :
             shells.entryList({ QStringLiteral("*.qml") }, QDir::Files,
                              QDir::Name))
            m_shells.append(shells.absoluteFilePath(entry));
        std::printf("GALLERY_SHELLS n=%d\n", (int)m_shells.size());
        std::fflush(stdout);

        const int themeRows = ((int)m_themes.size() + kColumns - 1) / kColumns;
        resize(kMargin * 2 + kColumns * kCardW + (kColumns - 1) * kGap,
               kHeaderH + kSectionH + themeRows * (kCardH + kGap) + kSectionH
                   + kShellH + kMargin);

        auto *timer = new QTimer(this);
        connect(timer, &QTimer::timeout, this,
                [this] { update(); });
        timer->start(1000);
    }

    ~GalleryWindow() override
    {
        if (m_quickshell) {
            m_quickshell->kill();
            m_quickshell->waitForFinished(3000);
        }
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.fillRect(QRect(0, 0, width(), height()), kWindow);

        QFont titleFont = p.font();
        titleFont.setPixelSize(20);
        titleFont.setBold(true);
        p.setFont(titleFont);
        p.setPen(kText);
        p.drawText(QRect(kMargin, 0, width() - 2 * kMargin, kHeaderH),
                   Qt::AlignVCenter | Qt::AlignLeft,
                   QStringLiteral("Omarchy Theme Gallery"));
        QFont small = p.font();
        small.setPixelSize(12);
        small.setBold(false);
        p.setFont(small);
        p.setPen(kDimText);
        p.drawText(QRect(kMargin, 0, width() - 2 * kMargin, kHeaderH),
                   Qt::AlignVCenter | Qt::AlignRight,
                   QTime::currentTime().toString(QStringLiteral("hh:mm:ss")));

        p.setPen(kDimText);
        p.drawText(QRect(kMargin, kHeaderH, width() - 2 * kMargin, kSectionH),
                   Qt::AlignVCenter | Qt::AlignLeft,
                   QStringLiteral("Themes — click to restyle the desktop"));
        for (int i = 0; i < (int)m_themes.size(); i++)
            paintThemeCard(p, i);

        const int shellTop = shellSectionTop();
        p.setPen(kDimText);
        p.drawText(QRect(kMargin, shellTop, width() - 2 * kMargin, kSectionH),
                   Qt::AlignVCenter | Qt::AlignLeft,
                   QStringLiteral("Quickshell — click to swap the shell"));
        for (int i = 0; i < (int)m_shells.size(); i++)
            paintShellCard(p, i);

        if (!m_exposed) {
            m_exposed = true;
            std::printf("GALLERY_EXPOSED %dx%d\n", width(), height());
            std::fflush(stdout);
        }
    }

    void mouseMoveEvent(QMouseEvent *e) override
    {
        const int hit = cardAt(e->position().toPoint());
        if (hit == m_hover) return;
        m_hover = hit;
        update();
    }

    void mousePressEvent(QMouseEvent *e) override
    {
        const int hit = cardAt(e->position().toPoint());
        if (hit < 0) return;
        m_selected = hit;
        activate(hit);
    }

    void keyPressEvent(QKeyEvent *e) override
    {
        const int total = (int)m_themes.size() + (int)m_shells.size();
        switch (e->key()) {
        case Qt::Key_Escape:
        case Qt::Key_Q:
            close();
            return;
        case Qt::Key_Left:
            if (total == 0) return;
            m_selected = (m_selected + total - 1) % total;
            break;
        case Qt::Key_Right:
            if (total == 0) return;
            m_selected = (m_selected + 1) % total;
            break;
        case Qt::Key_Return:
        case Qt::Key_Enter:
        case Qt::Key_Space:
            activate(m_selected);
            return;
        default:
            return;
        }
        update();
    }

private:
    static constexpr int kColumns = 3;
    static constexpr int kMargin = 24;
    static constexpr int kGap = 16;
    static constexpr int kCardW = 216;
    static constexpr int kCardH = 132;
    static constexpr int kShellH = 64;
    static constexpr int kHeaderH = 56;
    static constexpr int kSectionH = 32;

    int shellSectionTop() const
    {
        const int themeRows = ((int)m_themes.size() + kColumns - 1) / kColumns;
        return kHeaderH + kSectionH + themeRows * (kCardH + kGap);
    }

    QRect themeCardRect(int i) const
    {
        return QRect(kMargin + (i % kColumns) * (kCardW + kGap),
                     kHeaderH + kSectionH + (i / kColumns) * (kCardH + kGap),
                     kCardW, kCardH);
    }

    QRect shellCardRect(int i) const
    {
        return QRect(kMargin + i * (kCardW + kGap),
                     shellSectionTop() + kSectionH, kCardW, kShellH);
    }

    /* Cards index a single selection space: themes first, shells after. */
    int cardAt(const QPoint &pos) const
    {
        for (int i = 0; i < (int)m_themes.size(); i++)
            if (themeCardRect(i).contains(pos)) return i;
        for (int i = 0; i < (int)m_shells.size(); i++)
            if (shellCardRect(i).contains(pos))
                return (int)m_themes.size() + i;
        return -1;
    }

    void paintCardFrame(QPainter &p, const QRect &r, int index)
    {
        QPainterPath path;
        path.addRoundedRect(r, 10, 10);
        p.fillPath(path, kCard);
        QPen pen(index == m_selected ? kAccent
                 : index == m_hover  ? kText
                                     : kCardBorder);
        pen.setWidth(2);
        p.setPen(pen);
        p.setBrush(Qt::NoBrush);
        p.drawPath(path);
    }

    void paintThemeCard(QPainter &p, int i)
    {
        const Theme &t = m_themes[i];
        const QRect r = themeCardRect(i);
        paintCardFrame(p, r, i);

        const QRect preview = r.adjusted(10, 10, -10, -34);
        QLinearGradient wall(preview.topLeft(), preview.bottomLeft());
        wall.setColorAt(0, t.wallpaperTop);
        wall.setColorAt(1, t.wallpaperBottom);
        QPainterPath clip;
        clip.addRoundedRect(preview, 6, 6);
        p.save();
        p.setClipPath(clip);
        p.fillRect(preview, wall);
        p.fillRect(QRect(preview.x(), preview.y(), preview.width(), 12),
                   t.bar);
        p.fillRect(QRect(preview.x() + 4, preview.y() + 3, 24, 6), t.accent);

        const int winY = preview.y() + 18;
        const int winH = preview.height() - 24;
        const int winW = (preview.width() - 18) / 2;
        QPen border(t.border);
        border.setWidth(2);
        p.setPen(border);
        p.setBrush(t.occupied);
        p.drawRect(QRect(preview.x() + 6, winY, winW, winH));
        p.setPen(QPen(t.occupied.lighter(130), 2));
        p.drawRect(QRect(preview.x() + 12 + winW, winY, winW, winH));
        p.restore();

        QFont f = p.font();
        f.setPixelSize(13);
        p.setFont(f);
        p.setPen(t.foreground);
        p.drawText(QRect(r.x() + 12, r.bottom() - 28, r.width() - 24, 22),
                   Qt::AlignVCenter | Qt::AlignLeft, t.title);
        p.setPen(t.accent);
        p.setBrush(t.accent);
        p.drawEllipse(QPoint(r.right() - 18, r.bottom() - 17), 4, 4);
    }

    void paintShellCard(QPainter &p, int i)
    {
        const QRect r = shellCardRect(i);
        const int index = (int)m_themes.size() + i;
        paintCardFrame(p, r, index);

        const QString base = QFileInfo(m_shells[i]).baseName();
        QFont f = p.font();
        f.setPixelSize(13);
        p.setFont(f);
        p.setPen(kText);
        p.drawText(QRect(r.x() + 12, r.y() + 8, r.width() - 24, 20),
                   Qt::AlignVCenter | Qt::AlignLeft, titleCase(base));
        p.setPen(kDimText);
        p.drawText(QRect(r.x() + 12, r.y() + 30, r.width() - 24, 20),
                   Qt::AlignVCenter | Qt::AlignLeft,
                   base + QStringLiteral(".qml"));
    }

    void activate(int index)
    {
        if (index < (int)m_themes.size()) {
            const QString &name = m_themes[index].name;
            const QString reply = kwlctlDispatch(
                QStringLiteral("dispatch theme ") + name);
            std::printf("GALLERY_APPLY theme=%s reply=%s\n",
                        name.toUtf8().constData(),
                        reply.isEmpty() ? "unreachable"
                                        : reply.toUtf8().constData());
            std::fflush(stdout);
        } else {
            const QString &file = m_shells[index - (int)m_themes.size()];
            if (m_quickshell) {
                m_quickshell->kill();
                m_quickshell->waitForFinished(3000);
                delete m_quickshell;
            }
            m_quickshell = new QProcess;
            m_quickshell->setProgram(
                QStringLiteral("/usr/local/bin/quickshell"));
            m_quickshell->setArguments({ QStringLiteral("-p"), file });
            m_quickshell->start();
            m_quickshell->waitForStarted(10000);
            std::printf("GALLERY_SHELL file=%s pid=%lld\n",
                        file.toUtf8().constData(),
                        (long long)m_quickshell->processId());
            std::fflush(stdout);
        }
        update();
    }

    QList<Theme> m_themes;
    QStringList m_shells;
    QProcess *m_quickshell = nullptr;
    int m_hover = -1;
    int m_selected = 0;
    bool m_exposed = false;
};

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    std::printf("GALLERY_PLATFORM=%s\n",
                app.platformName().toUtf8().constData());
    std::fflush(stdout);
    GalleryWindow w;
    w.show();
    return app.exec();
}
