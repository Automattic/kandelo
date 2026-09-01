/*
 * qtdemo — the first Qt window on the Kandelo desktop.
 *
 * A QRasterWindow painted through QtGui's raster engine onto a wl_shm
 * buffer: an animated wave field, gradient-filled type and a live clock,
 * in the Tokyo Night palette the desktop themes default to. Everything
 * antialiased — the point of the demo is what the Qt paint stack adds
 * over the C clients' wpkdraw.
 *
 * A static Qt registers a plugin only when the program imports it, so
 * the two Q_IMPORT_PLUGIN lines are what put the wayland QPA key and
 * the xdg-shell integration into this binary.
 *
 * Markers on stdout (the smoke test reads them):
 *   QTDEMO_PLATFORM=<qpa>    after QGuiApplication construction
 *   QTDEMO_EXPOSED <w>x<h>   once, on the first paint
 *   QTDEMO_FRAME n=<count>   every 30th frame
 *
 * Escape or Q closes the window.
 */
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QLinearGradient>
#include <QPainter>
#include <QPainterPath>
#include <QRasterWindow>
#include <QTime>
#include <QTimer>
#include <QtPlugin>

#include <cmath>
#include <cstdio>

Q_IMPORT_PLUGIN(QWaylandIntegrationPlugin)
Q_IMPORT_PLUGIN(QWaylandXdgShellIntegrationPlugin)

namespace {

const QColor kBackgroundTop(0x24, 0x28, 0x3b);
const QColor kBackgroundBottom(0x1a, 0x1b, 0x26);
const QColor kCard(0x1f, 0x23, 0x35, 0xd8);
const QColor kCardBorder(0x3b, 0x42, 0x61);
const QColor kBlue(0x7a, 0xa2, 0xf7);
const QColor kPurple(0xbb, 0x9a, 0xf7);
const QColor kCyan(0x7d, 0xcf, 0xff);
const QColor kGreen(0x9e, 0xce, 0x6a);
const QColor kDimText(0xa9, 0xb1, 0xd6);

} // namespace

class DemoWindow : public QRasterWindow
{
public:
    DemoWindow()
    {
        setTitle(QStringLiteral("Qt on Kandelo"));
        resize(640, 400);
        m_clock.start();
        auto *timer = new QTimer(this);
        connect(timer, &QTimer::timeout, this, [this] { update(); });
        timer->start(40);
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        const qreal t = m_clock.elapsed() / 1000.0;
        const int w = width();
        const int h = height();

        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setRenderHint(QPainter::TextAntialiasing);

        QLinearGradient sky(0, 0, 0, h);
        sky.setColorAt(0.0, kBackgroundTop);
        sky.setColorAt(1.0, kBackgroundBottom);
        p.fillRect(0, 0, w, h, sky);

        drawWave(p, t, 0.00, kBlue);
        drawWave(p, t, 2.09, kPurple);
        drawWave(p, t, 4.19, kCyan);

        drawCard(p, t);

        if (!m_exposed) {
            m_exposed = true;
            std::printf("QTDEMO_EXPOSED %dx%d\n", w, h);
            std::fflush(stdout);
        }
        ++m_frames;
        if (m_frames % 30 == 0) {
            std::printf("QTDEMO_FRAME n=%d\n", m_frames);
            std::fflush(stdout);
        }
    }

    void keyPressEvent(QKeyEvent *event) override
    {
        if (event->key() == Qt::Key_Escape || event->key() == Qt::Key_Q)
            close();
    }

private:
    void drawWave(QPainter &p, qreal t, qreal phase, const QColor &color)
    {
        const int w = width();
        const int h = height();
        const qreal mid = h * 0.62;
        const qreal amp = h * 0.16;

        QPainterPath path;
        for (int x = 0; x <= w; x += 6) {
            const qreal k = x / qreal(w);
            const qreal y = mid
                + amp * std::sin(k * 6.28318 * 1.5 + t * 1.3 + phase)
                * std::sin(k * 3.14159);
            if (x == 0)
                path.moveTo(x, y);
            else
                path.lineTo(x, y);
        }

        QColor stroke = color;
        stroke.setAlpha(0xb4);
        p.setPen(QPen(stroke, 2.5));
        p.setBrush(Qt::NoBrush);
        p.drawPath(path);

        QPainterPath fill = path;
        fill.lineTo(w, h);
        fill.lineTo(0, h);
        fill.closeSubpath();
        QColor veil = color;
        veil.setAlpha(0x16);
        p.fillPath(fill, veil);
    }

    void drawCard(QPainter &p, qreal t)
    {
        const int w = width();
        const int h = height();
        const qreal cardW = qMin<qreal>(w * 0.82, 480);
        const qreal cardH = qMin<qreal>(h * 0.44, 176);
        const QRectF card((w - cardW) / 2, h * 0.14, cardW, cardH);

        p.setPen(QPen(kCardBorder, 1));
        p.setBrush(kCard);
        p.drawRoundedRect(card, 12, 12);

        QFont title(QStringLiteral("sans-serif"));
        title.setPixelSize(int(cardH * 0.30));
        title.setBold(true);
        p.setFont(title);
        QLinearGradient ink(card.left(), 0, card.right(), 0);
        ink.setColorAt(0.0, kBlue);
        ink.setColorAt(0.5, kPurple);
        ink.setColorAt(1.0, kCyan);
        p.setPen(QPen(QBrush(ink), 0));
        p.drawText(card.adjusted(0, cardH * 0.12, 0, 0),
                   Qt::AlignHCenter | Qt::AlignTop,
                   QStringLiteral("Qt on Kandelo"));

        QFont sub(QStringLiteral("sans-serif"));
        sub.setPixelSize(int(cardH * 0.11));
        p.setFont(sub);
        p.setPen(kDimText);
        p.drawText(card.adjusted(0, cardH * 0.52, 0, 0),
                   Qt::AlignHCenter | Qt::AlignTop,
                   QStringLiteral("QtGui %1 · wayland · wl_shm")
                       .arg(QStringLiteral(QT_VERSION_STR)));

        QFont clock(QStringLiteral("monospace"));
        clock.setPixelSize(int(cardH * 0.14));
        p.setFont(clock);
        p.setPen(kGreen);
        p.drawText(card.adjusted(0, 0, 0, -cardH * 0.10),
                   Qt::AlignHCenter | Qt::AlignBottom,
                   QTime::currentTime().toString(QStringLiteral("HH:mm:ss")));

        const qreal r = 3 + 1.5 * std::sin(t * 2.0);
        p.setPen(Qt::NoPen);
        p.setBrush(kGreen);
        p.drawEllipse(QPointF(card.right() - 16, card.top() + 16), r, r);
    }

    QElapsedTimer m_clock;
    bool m_exposed = false;
    int m_frames = 0;
};

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    std::printf("QTDEMO_PLATFORM=%s\n", qPrintable(app.platformName()));
    std::fflush(stdout);

    DemoWindow window;
    window.show();
    return app.exec();
}
