/*
 * Stage-2 gate for the Qt port: QtGui and the Wayland platform plugin run
 * on the kernel.
 *
 * Qt 6.10 moved the Wayland client platform plugin into qtbase
 * (src/plugins/platforms/wayland), so QtWaylandClient and the `wayland`
 * QPA key come out of this one package. A static Qt registers a plugin
 * only when the program imports it, so Q_IMPORT_PLUGIN below is what
 * proves the plugin archive linked.
 *
 * The paint passes run on the offscreen platform: they need no
 * compositor, and they exercise the two parts of QtGui that had to be
 * cross-compiled rather than merely linked — the raster engine, and the
 * font stack reaching fontconfig, FreeType and HarfBuzz.
 *
 * The caller supplies the font through FONTCONFIG_FILE, as the gtk3,
 * foot, mako and waybar smokes do. What that proves is the matching
 * path: fontconfig finds the file, FreeType rasterises it, and the
 * glyphs reach the image. It does not prove enumeration — QFontDatabase
 * reports only Qt's three generic families here, never the staged
 * family name, so this asserts ink rather than a name.
 *
 * The QProcess pass re-execs this program with --child through Qt's
 * bundled forkfd. forkfd-generic-on-wasm.patch keeps forkfd off its
 * clone(2) path, so this is the proof that its generic fork() fallback
 * carries a spawn, an exec, SIGCHLD reaping and the child's pipes on
 * the kernel — the surface Quickshell's QProcess use stands on.
 */
#include <QFont>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QImage>
#include <QJsonArray>
#include <QJsonObject>
#include <QPainter>
#include <QPluginLoader>
#include <QProcess>
#include <QStaticPlugin>
#include <QtPlugin>

#include <cstdio>
#include <cstring>

Q_IMPORT_PLUGIN(QOffscreenIntegrationPlugin)
Q_IMPORT_PLUGIN(QWaylandIntegrationPlugin)
Q_IMPORT_PLUGIN(QWaylandXdgShellIntegrationPlugin)

static bool keyIsRegistered(const QString &iid, const QString &key)
{
    for (const QStaticPlugin &plugin : QPluginLoader::staticPlugins()) {
        const QJsonObject metaData = plugin.metaData();
        if (metaData.value(QStringLiteral("IID")).toString() != iid)
            continue;
        const QJsonArray keys =
            metaData.value(QStringLiteral("MetaData")).toObject()
                .value(QStringLiteral("Keys")).toArray();
        for (const QJsonValue &candidate : keys) {
            if (candidate.toString().compare(key, Qt::CaseInsensitive) == 0)
                return true;
        }
    }
    return false;
}

static int inkedPixels(const QImage &image)
{
    int inked = 0;
    for (int y = 0; y < image.height(); ++y) {
        for (int x = 0; x < image.width(); ++x) {
            if (image.pixel(x, y) != 0xff000000u)
                ++inked;
        }
    }
    return inked;
}

int main(int argc, char **argv)
{
    if (argc > 1 && std::strcmp(argv[1], "--child") == 0) {
        std::printf("QT_PROCESS_CHILD_OK\n");
        return 0;
    }

    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);

    std::printf("QT_VERSION=%s\n", qVersion());
    std::printf("PLATFORM=%s\n", qPrintable(app.platformName()));
    const QString platformIid = QStringLiteral(
        "org.qt-project.Qt.QPA.QPlatformIntegrationFactoryInterface.5.3");
    const QString shellIid = QStringLiteral(
        "org.qt-project.Qt.WaylandClient.QWaylandShellIntegrationFactoryInterface.5.3");
    std::printf("WAYLAND_PLUGIN=%s\n",
                keyIsRegistered(platformIid, QStringLiteral("wayland")) ? "yes" : "no");
    std::printf("XDG_SHELL_PLUGIN=%s\n",
                keyIsRegistered(shellIid, QStringLiteral("xdg-shell")) ? "yes" : "no");

    const QStringList families = QFontDatabase::families();
    std::printf("FONT_FAMILIES=%lld\n", static_cast<long long>(families.size()));

    QImage canvas(96, 48, QImage::Format_ARGB32);
    canvas.fill(Qt::black);
    QPainter painter(&canvas);
    painter.fillRect(16, 8, 32, 16, Qt::red);
    painter.end();

    std::printf("CORNER=%08x\n", canvas.pixel(0, 0));
    std::printf("CENTRE=%08x\n", canvas.pixel(32, 16));

    QImage typeset(96, 48, QImage::Format_ARGB32);
    typeset.fill(Qt::black);
    QPainter scribe(&typeset);
    QFont font(QStringLiteral("Monospace"));
    font.setPixelSize(24);
    scribe.setFont(font);
    scribe.setPen(Qt::white);
    scribe.drawText(typeset.rect(), Qt::AlignCenter, QStringLiteral("Kan"));
    scribe.end();

    const int inked = inkedPixels(typeset);
    std::printf("GLYPH_PIXELS=%d\n", inked);

    QProcess child;
    child.start(QString::fromLocal8Bit(argv[0]),
                { QStringLiteral("--child") });
    const bool finished = child.waitForFinished(30000);
    const QByteArray childOut = child.readAllStandardOutput();
    std::printf("QPROCESS_EXIT=%d\n", finished ? child.exitCode() : -1);
    std::fwrite(childOut.constData(), 1, size_t(childOut.size()), stdout);

    if (app.platformName() != QLatin1String("offscreen")) return 1;
    if (!keyIsRegistered(platformIid, QStringLiteral("wayland"))) return 2;
    if (!keyIsRegistered(shellIid, QStringLiteral("xdg-shell"))) return 7;
    if (canvas.pixel(0, 0) != 0xff000000u) return 3;
    if (canvas.pixel(32, 16) != 0xffff0000u) return 4;
    if (families.isEmpty()) return 5;
    if (inked == 0) return 6;
    if (!finished || child.exitCode() != 0) return 8;
    if (!childOut.contains("QT_PROCESS_CHILD_OK")) return 9;

    std::printf("QT_GUI_SMOKE_OK\n");
    return 0;
}
