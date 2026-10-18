/*
 * Stage-3 gate for the Qt port: the QML engine and the QtQuick software
 * scenegraph run on the kernel.
 *
 * The QML comes from a byte array, not a file — what this gate proves
 * is the engine, not the VFS. QQmlApplicationEngine::loadData compiles
 * it with the linked-in QML runtime; a static Qt resolves the QtQuick
 * import through the imported plugins below, so a missing plugin
 * archive fails here as an unresolved import, not a silent fallback.
 *
 * The scenegraph must settle on the software adaptation:
 * QT_QUICK_BACKEND=software is exported before the application exists,
 * and the renderer interface is asserted afterwards. grabWindow() on
 * the offscreen platform renders the scene synchronously on the CPU —
 * the same raster path the compositor's wl_shm pools receive.
 *
 * The caller supplies the font through FONTCONFIG_FILE, as the qtbase
 * gui smoke does: the Text item asserts ink, not a family name.
 */
#include <QGuiApplication>
#include <QImage>
#include <QQmlApplicationEngine>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QtQml/qqmlextensionplugin.h>

#include <cstdio>

Q_IMPORT_PLUGIN(QOffscreenIntegrationPlugin)
Q_IMPORT_QML_PLUGIN(QtQmlPlugin)
Q_IMPORT_QML_PLUGIN(QtQmlModelsPlugin)
Q_IMPORT_QML_PLUGIN(QtQmlWorkerScriptPlugin)
Q_IMPORT_QML_PLUGIN(QtQuick2Plugin)
Q_IMPORT_QML_PLUGIN(QtQuick_WindowPlugin)

static const char qml[] = R"(
import QtQuick

Window {
    visible: true
    width: 96
    height: 48
    color: "black"

    Rectangle { x: 16; y: 8; width: 32; height: 16; color: "red" }

    Text {
        anchors.centerIn: parent
        text: "Kan"
        color: "white"
        font.pixelSize: 24
    }
}
)";

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
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    qputenv("QT_QPA_PLATFORM", "offscreen");
    qputenv("QT_QUICK_BACKEND", "software");
    QGuiApplication app(argc, argv);

    std::printf("QT_VERSION=%s\n", qVersion());
    std::printf("PLATFORM=%s\n", qPrintable(app.platformName()));

    QQmlApplicationEngine engine;
    engine.loadData(QByteArray(qml));
    const QList<QObject *> roots = engine.rootObjects();
    std::printf("QML_ROOTS=%lld\n", static_cast<long long>(roots.size()));
    if (roots.isEmpty()) return 2;

    QQuickWindow *window = qobject_cast<QQuickWindow *>(roots.first());
    std::printf("QML_WINDOW=%s\n", window ? "yes" : "no");
    if (!window) return 3;

    const QSGRendererInterface::GraphicsApi api =
        window->rendererInterface()->graphicsApi();
    std::printf("SCENEGRAPH_SOFTWARE=%s\n",
                api == QSGRendererInterface::Software ? "yes" : "no");

    const QImage grab = window->grabWindow();
    std::printf("GRAB_SIZE=%dx%d\n", grab.width(), grab.height());
    if (grab.width() < 96 || grab.height() < 48) return 4;

    const QImage frame =
        grab.convertToFormat(QImage::Format_ARGB32).scaled(96, 48);
    std::printf("CORNER=%08x\n", frame.pixel(2, 2));
    std::printf("CENTRE=%08x\n", frame.pixel(32, 16));

    const int inked = inkedPixels(frame);
    std::printf("GLYPH_PIXELS=%d\n", inked);

    if (app.platformName() != QLatin1String("offscreen")) return 1;
    if (api != QSGRendererInterface::Software) return 5;
    if (frame.pixel(2, 2) != 0xff000000u) return 6;
    if (frame.pixel(32, 16) != 0xffff0000u) return 7;
    if (inked == 0) return 8;

    std::printf("QT_QML_SMOKE_OK\n");
    return 0;
}
