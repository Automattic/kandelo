// Kandelo platform backends for upstream LÖVE modules.
//
// These classes provide the small native pieces the upstream renderer expects
// without using SDL: a window object backed by Kandelo's KMS/EGL surface, and
// a filesystem object backed by the package's mounted POSIX directory.

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <cctype>
#include <limits>
#include <set>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

extern "C" {
#include "lua.h"
#include "lauxlib.h"
}

extern "C" void kandelo_love_set_native_window_size(int width, int height);

#include "common/Exception.h"
#include "common/Module.h"
#include "common/runtime.h"
#include "modules/data/wrap_Data.h"
#include "modules/data/wrap_DataModule.h"
#include "modules/filesystem/Filesystem.h"
#include "modules/filesystem/File.h"
#include "modules/filesystem/FileData.h"
#include "modules/filesystem/wrap_Filesystem.h"
#include "modules/font/wrap_Font.h"
#include "modules/graphics/Graphics.h"
#include "modules/graphics/wrap_Graphics.h"
#include "modules/image/wrap_Image.h"
#include "modules/math/wrap_Math.h"
#include "modules/physics/box2d/wrap_Physics.h"
#include "modules/thread/Channel.h"
#include "modules/thread/threads.h"
#include "modules/thread/wrap_Channel.h"
#include "modules/window/Window.h"
#include "modules/window/wrap_Window.h"

namespace {

using SwapCallback = bool (*)();

struct NativeState {
  std::string root;
  int width = 960;
  int height = 540;
  int pixelWidth = 960;
  int pixelHeight = 540;
  int desktopWidth = 960;
  int desktopHeight = 540;
  SwapCallback swap = nullptr;
};

NativeState gNative;

std::string joinPath(const std::string &root, const std::string &name) {
  if (name.empty()) return root;
  if (name[0] == '/') return name;
  if (root.empty() || root == ".") return name;
  if (root.back() == '/') return root + name;
  return root + "/" + name;
}

std::string sanitizePathComponent(const std::string &name) {
  std::string out;
  out.reserve(name.size());
  for (unsigned char ch : name) {
    if (std::isalnum(ch) || ch == '-' || ch == '_' || ch == '.')
      out.push_back(char(ch));
    else
      out.push_back('_');
  }
  return out.empty() ? "kandelo-love" : out;
}

bool mkdirRecursive(const std::string &path) {
  if (path.empty()) return false;
  std::string cur;
  size_t i = 0;
  if (path[0] == '/') {
    cur = "/";
    i = 1;
  }

  while (i <= path.size()) {
    size_t next = path.find('/', i);
    std::string part = path.substr(i, next == std::string::npos ? std::string::npos : next - i);
    if (!part.empty()) {
      if (cur.size() > 1 && cur.back() != '/') cur.push_back('/');
      cur += part;
      if (mkdir(cur.c_str(), 0777) != 0 && errno != EEXIST) return false;
    }
    if (next == std::string::npos) break;
    i = next + 1;
  }
  return true;
}

bool ensureParentDirectory(const std::string &path) {
  size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) return true;
  if (slash == 0) return true;
  return mkdirRecursive(path.substr(0, slash));
}

bool statToInfo(const std::string &path, love::filesystem::Filesystem::Info &info) {
  struct stat st {};
  if (stat(path.c_str(), &st) != 0) return false;
  info.size = S_ISREG(st.st_mode) ? st.st_size : -1;
  info.modtime = st.st_mtime;
  if (S_ISREG(st.st_mode)) info.type = love::filesystem::Filesystem::FILETYPE_FILE;
  else if (S_ISDIR(st.st_mode)) info.type = love::filesystem::Filesystem::FILETYPE_DIRECTORY;
  else if (S_ISLNK(st.st_mode)) info.type = love::filesystem::Filesystem::FILETYPE_SYMLINK;
  else info.type = love::filesystem::Filesystem::FILETYPE_OTHER;
  return true;
}

class KandeloFile final : public love::filesystem::File {
public:
  KandeloFile(std::string filename, std::string sourceRoot, std::string saveRoot)
      : filename(std::move(filename)),
        sourcePath(joinPath(sourceRoot, this->filename)),
        savePath(joinPath(saveRoot, this->filename)) {}

  ~KandeloFile() override {
    close();
  }

  bool open(Mode mode) override {
    close();
    const char *m = nullptr;
    switch (mode) {
      case MODE_READ: m = "rb"; break;
      case MODE_WRITE: m = "wb"; break;
      case MODE_APPEND: m = "ab"; break;
      default: return false;
    }
    if (mode == MODE_READ) {
      activePath = savePath;
      struct stat st {};
      if (stat(activePath.c_str(), &st) != 0 || !S_ISREG(st.st_mode))
        activePath = sourcePath;
    } else {
      activePath = savePath;
      if (!ensureParentDirectory(activePath)) return false;
    }
    fp = std::fopen(activePath.c_str(), m);
    if (!fp) return false;
    currentMode = mode;
    return true;
  }

  bool close() override {
    if (!fp) {
      currentMode = MODE_CLOSED;
      return true;
    }
    bool ok = std::fclose(fp) == 0;
    fp = nullptr;
    currentMode = MODE_CLOSED;
    return ok;
  }

  bool isOpen() const override {
    return fp != nullptr;
  }

  love::int64 getSize() override {
    struct stat st {};
    std::string path = fp ? activePath : readablePath();
    if (stat(path.c_str(), &st) != 0) return -1;
    return st.st_size;
  }

  love::int64 read(void *dst, love::int64 size) override {
    if (!fp || size < 0) return -1;
    return std::fread(dst, 1, size_t(size), fp);
  }

  bool write(const void *data, love::int64 size) override {
    if (!fp || size < 0) return false;
    return std::fwrite(data, 1, size_t(size), fp) == size_t(size);
  }

  bool flush() override {
    return fp ? std::fflush(fp) == 0 : false;
  }

  bool isEOF() override {
    return fp ? std::feof(fp) != 0 : true;
  }

  love::int64 tell() override {
    if (!fp) return -1;
    long pos = std::ftell(fp);
    return pos < 0 ? -1 : pos;
  }

  bool seek(love::uint64 pos) override {
    if (!fp || pos > love::uint64(std::numeric_limits<long>::max())) return false;
    return std::fseek(fp, long(pos), SEEK_SET) == 0;
  }

  bool setBuffer(BufferMode, love::int64) override {
    return true;
  }

  BufferMode getBuffer(love::int64 &size) const override {
    size = 0;
    return BUFFER_NONE;
  }

  Mode getMode() const override {
    return currentMode;
  }

  const std::string &getFilename() const override {
    return filename;
  }

private:
  std::string readablePath() const {
    struct stat st {};
    if (stat(savePath.c_str(), &st) == 0 && S_ISREG(st.st_mode)) return savePath;
    return sourcePath;
  }

  std::string filename;
  std::string sourcePath;
  std::string savePath;
  std::string activePath;
  FILE *fp = nullptr;
  Mode currentMode = MODE_CLOSED;
};

class KandeloFilesystem final : public love::filesystem::Filesystem {
public:
  explicit KandeloFilesystem(std::string root)
      : root(std::move(root)), source(this->root) {
    refreshSaveRoot();
  }

  const char *getName() const override { return "love.filesystem.kandelo"; }

  void init(const char *) override {}
  void setFused(bool fused) override { this->fused = fused; }
  bool isFused() const override { return fused; }
  bool setupWriteDirectory() override { return true; }
  bool setIdentity(const char *ident, bool) override {
    identity = ident ? ident : "";
    refreshSaveRoot();
    return true;
  }
  const char *getIdentity() const override { return identity.c_str(); }
  bool setSource(const char *src) override {
    source = src ? src : "";
    return true;
  }
  const char *getSource() const override { return source.c_str(); }
  bool mount(const char *, const char *, bool) override { return false; }
  bool mount(love::Data *, const char *, const char *, bool) override { return false; }
  bool unmount(const char *) override { return false; }
  bool unmount(love::Data *) override { return false; }

  love::filesystem::File *newFile(const char *filename) const override {
    return new KandeloFile(filename ? filename : "", root, saveRoot);
  }

  const char *getWorkingDirectory() override { return root.c_str(); }
  std::string getUserDirectory() override { return saveBase; }
  std::string getAppdataDirectory() override { return saveBase; }
  const char *getSaveDirectory() override { return saveRoot.c_str(); }
  std::string getSourceBaseDirectory() const override { return source; }
  std::string getRealDirectory(const char *filename) const override {
    std::string path = joinPath(saveRoot, filename ? filename : "");
    love::filesystem::Filesystem::Info info {};
    if (statToInfo(path, info)) return saveRoot;
    path = joinPath(root, filename ? filename : "");
    return statToInfo(path, info) ? root : "";
  }

  bool getInfo(const char *filepath, Info &info) const override {
    if (statToInfo(joinPath(saveRoot, filepath ? filepath : ""), info)) return true;
    return statToInfo(joinPath(root, filepath ? filepath : ""), info);
  }

  bool createDirectory(const char *dir) override {
    return mkdirRecursive(joinPath(saveRoot, dir ? dir : ""));
  }

  bool remove(const char *file) override {
    return ::remove(joinPath(saveRoot, file ? file : "").c_str()) == 0;
  }

  love::filesystem::FileData *read(const char *filename, love::int64 size) const override {
    love::filesystem::File *file = newFile(filename);
    try {
      love::filesystem::FileData *data = file->read(size);
      file->release();
      return data;
    } catch (...) {
      file->release();
      throw;
    }
  }

  void write(const char *filename, const void *data, love::int64 size) const override {
    writeMode(filename, data, size, love::filesystem::File::MODE_WRITE);
  }

  void append(const char *filename, const void *data, love::int64 size) const override {
    writeMode(filename, data, size, love::filesystem::File::MODE_APPEND);
  }

  void getDirectoryItems(const char *dir, std::vector<std::string> &items) override {
    std::set<std::string> names;
    appendDirectoryItems(joinPath(root, dir ? dir : ""), names);
    appendDirectoryItems(joinPath(saveRoot, dir ? dir : ""), names);
    items.assign(names.begin(), names.end());
  }

  void setSymlinksEnabled(bool enable) override { symlinks = enable; }
  bool areSymlinksEnabled() const override { return symlinks; }
  std::vector<std::string> &getRequirePath() override { return requirePath; }
  std::vector<std::string> &getCRequirePath() override { return cRequirePath; }
  void allowMountingForPath(const std::string &) override {}

private:
  void refreshSaveRoot() {
    saveRoot = joinPath(saveBase, sanitizePathComponent(identity));
    mkdirRecursive(saveRoot);
  }

  static void appendDirectoryItems(const std::string &path, std::set<std::string> &items) {
    DIR *d = opendir(path.c_str());
    if (!d) return;
    while (dirent *ent = readdir(d)) {
      if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0) continue;
      items.emplace(ent->d_name);
    }
    closedir(d);
  }

  void writeMode(const char *filename, const void *data, love::int64 size,
                 love::filesystem::File::Mode mode) const {
    KandeloFile file(filename ? filename : "", root, saveRoot);
    if (!file.open(mode)) throw love::Exception("Could not open file %s.", filename ? filename : "");
    if (!file.write(data, size)) throw love::Exception("Could not write file %s.", filename ? filename : "");
  }

  std::string root;
  std::string source;
  std::string saveBase = "/tmp/kandelo-love";
  std::string saveRoot;
  std::string identity = "kandelo-love";
  bool fused = false;
  bool symlinks = true;
  std::vector<std::string> requirePath = {"?.lua", "?/init.lua"};
  std::vector<std::string> cRequirePath;
};

class KandeloWindow final : public love::window::Window {
public:
  KandeloWindow(int width, int height, int pixelWidth, int pixelHeight,
                int desktopWidth, int desktopHeight)
      : width(width), height(height), pixelWidth(pixelWidth), pixelHeight(pixelHeight),
        desktopWidth(desktopWidth), desktopHeight(desktopHeight) {
    settings.refreshrate = 60.0;
  }

  const char *getName() const override { return "love.window.kandelo"; }

  void setGraphics(love::graphics::Graphics *graphics) override { this->graphics = graphics; }

  bool setWindow(int width, int height, love::window::WindowSettings *settings) override {
    if (width > 0) this->width = width;
    if (height > 0) this->height = height;
    pixelWidth = this->width;
    pixelHeight = this->height;
    if (settings != nullptr) this->settings = *settings;
    if (this->settings.refreshrate <= 0.0) this->settings.refreshrate = 60.0;
    kandelo_love_set_native_window_size(this->width, this->height);
    open = true;
    if (graphics != nullptr) {
      double dpiW = this->width;
      double dpiH = this->height;
      windowToDPICoords(&dpiW, &dpiH);
      graphics->setMode((int)dpiW, (int)dpiH, pixelWidth, pixelHeight,
                        this->settings.stencil);
    }
    return true;
  }

  void getWindow(int &width, int &height, love::window::WindowSettings &settings) override {
    width = this->width;
    height = this->height;
    settings = this->settings;
  }

  void close() override { open = false; }
  bool setFullscreen(bool fullscreen, FullscreenType fstype) override {
    settings.fullscreen = fullscreen;
    settings.fstype = fstype;
    return true;
  }
  bool setFullscreen(bool fullscreen) override {
    settings.fullscreen = fullscreen;
    return true;
  }
  bool onSizeChanged(int width, int height) override {
    this->width = width;
    this->height = height;
    pixelWidth = this->width;
    pixelHeight = this->height;
    kandelo_love_set_native_window_size(this->width, this->height);
    return true;
  }

  int getDisplayCount() const override { return 1; }
  const char *getDisplayName(int) const override { return "Kandelo"; }
  DisplayOrientation getDisplayOrientation(int) const override { return ORIENTATION_LANDSCAPE; }
  std::vector<WindowSize> getFullscreenSizes(int) const override {
    return {{desktopWidth, desktopHeight}, {pixelWidth, pixelHeight}, {width, height}};
  }
  void getDesktopDimensions(int, int &width, int &height) const override {
    width = desktopWidth;
    height = desktopHeight;
  }
  void setPosition(int x, int y, int displayindex) override {
    posX = x;
    posY = y;
    display = displayindex;
  }
  void getPosition(int &x, int &y, int &displayindex) override {
    x = posX;
    y = posY;
    displayindex = display;
  }
  love::Rect getSafeArea() const override { return {0, 0, width, height}; }
  bool isOpen() const override { return open; }
  void setWindowTitle(const std::string &title) override { this->title = title; }
  const std::string &getWindowTitle() const override { return title; }
  bool setIcon(love::image::ImageData *imgd) override {
    icon.set(imgd);
    return true;
  }
  love::image::ImageData *getIcon() override { return icon.get(); }
  void setVSync(int vsync) override { settings.vsync = vsync; }
  int getVSync() const override { return settings.vsync; }
  void setDisplaySleepEnabled(bool enable) override { displaySleep = enable; }
  bool isDisplaySleepEnabled() const override { return displaySleep; }
  void minimize() override { minimized = true; }
  void maximize() override { maximized = true; minimized = false; }
  void restore() override { minimized = false; maximized = false; }
  bool isMaximized() const override { return maximized; }
  bool isMinimized() const override { return minimized; }

  void swapBuffers() override {
    if (gNative.swap != nullptr) gNative.swap();
  }

  bool hasFocus() const override { return true; }
  bool hasMouseFocus() const override { return true; }
  bool isVisible() const override { return true; }
  void setMouseGrab(bool grab) override { mouseGrab = grab; }
  bool isMouseGrabbed() const override { return mouseGrab; }
  int getWidth() const override { return width; }
  int getHeight() const override { return height; }
  int getPixelWidth() const override { return pixelWidth; }
  int getPixelHeight() const override { return pixelHeight; }
  void clampPositionInWindow(double *x, double *y) const override {
    if (x) *x = std::max(0.0, std::min(*x, double(width - 1)));
    if (y) *y = std::max(0.0, std::min(*y, double(height - 1)));
  }
  void windowToPixelCoords(double *x, double *y) const override { toPixelsInPlace(x, y); }
  void pixelToWindowCoords(double *x, double *y) const override { fromPixelsInPlace(x, y); }
  void windowToDPICoords(double *, double *) const override {}
  void DPIToWindowCoords(double *, double *) const override {}
  double getDPIScale() const override { return std::max(pixelWidth / double(width), pixelHeight / double(height)); }
  double getNativeDPIScale() const override { return getDPIScale(); }
  double toPixels(double x) const override { return x * getDPIScale(); }
  void toPixels(double wx, double wy, double &px, double &py) const override {
    px = toPixels(wx);
    py = toPixels(wy);
  }
  double fromPixels(double x) const override { return x / getDPIScale(); }
  void fromPixels(double px, double py, double &wx, double &wy) const override {
    wx = fromPixels(px);
    wy = fromPixels(py);
  }
  const void *getHandle() const override { return nullptr; }
  bool showMessageBox(const std::string &title, const std::string &message,
                      MessageBoxType, bool) override {
    std::fprintf(stderr, "love: %s: %s\n", title.c_str(), message.c_str());
    return true;
  }
  int showMessageBox(const MessageBoxData &data) override {
    std::fprintf(stderr, "love: %s: %s\n", data.title.c_str(), data.message.c_str());
    return 0;
  }
  void requestAttention(bool) override {}

private:
  void toPixelsInPlace(double *x, double *y) const {
    if (x) *x = toPixels(*x);
    if (y) *y = toPixels(*y);
  }
  void fromPixelsInPlace(double *x, double *y) const {
    if (x) *x = fromPixels(*x);
    if (y) *y = fromPixels(*y);
  }

  love::graphics::Graphics *graphics = nullptr;
  int width = 960;
  int height = 540;
  int pixelWidth = 960;
  int pixelHeight = 540;
  int desktopWidth = 960;
  int desktopHeight = 540;
  int posX = 0;
  int posY = 0;
  int display = 0;
  bool open = false;
  bool mouseGrab = false;
  bool displaySleep = true;
  bool minimized = false;
  bool maximized = false;
  std::string title = "LÖVE";
  love::window::WindowSettings settings;
  love::StrongRef<love::image::ImageData> icon;
};

struct LuaOpenCall {
  int (*fn)(lua_State *);
};

int luaOpenThunk(lua_State *L) {
  auto *call = static_cast<LuaOpenCall *>(lua_touserdata(L, 1));
  return call->fn(L);
}

bool callLuaOpen(lua_State *L, const char *name, int (*fn)(lua_State *)) {
  int top = lua_gettop(L);
  LuaOpenCall call {fn};
  lua_pushcfunction(L, luaOpenThunk);
  lua_pushlightuserdata(L, &call);
  if (lua_pcall(L, 1, 1, 0) != 0) {
    const char *msg = lua_tostring(L, -1);
    std::fprintf(stderr, "love: failed to load %s: %s\n", name, msg ? msg : "unknown");
    lua_settop(L, top);
    return false;
  }
  if (!lua_isnil(L, -1)) {
    const char *field = std::strrchr(name, '.');
    field = field ? field + 1 : name;

    lua_getglobal(L, "love");
    if (lua_istable(L, -1)) {
      lua_pushvalue(L, -2);
      lua_setfield(L, -2, field);
    }
    lua_pop(L, 1);

    lua_getglobal(L, "package");
    if (lua_istable(L, -1)) {
      lua_getfield(L, -1, "loaded");
      if (lua_istable(L, -1)) {
        lua_pushvalue(L, -3);
        lua_setfield(L, -2, name);
      }
      lua_pop(L, 1);
    }
    lua_pop(L, 1);
  }
  lua_settop(L, top);
  return true;
}

bool installFilesystem() {
  if (love::Module::getInstance<love::filesystem::Filesystem>(love::Module::M_FILESYSTEM) != nullptr)
    return true;
  love::Module::registerInstance(new KandeloFilesystem(gNative.root));
  return true;
}

bool installWindow() {
  if (love::Module::getInstance<love::window::Window>(love::Module::M_WINDOW) != nullptr)
    return true;
  love::Module::registerInstance(new KandeloWindow(gNative.width, gNative.height,
                                                   gNative.pixelWidth, gNative.pixelHeight,
                                                   gNative.desktopWidth, gNative.desktopHeight));
  return true;
}

}  // namespace

namespace love {
namespace thread {

class KandeloMutex final : public Mutex {
public:
  void lock() override {}
  void unlock() override {}
};

Mutex *newMutex() {
  return new KandeloMutex();
}

Lock::Lock(Mutex *m) : mutex(m) {
  if (mutex) mutex->lock();
}

Lock::Lock(Mutex &m) : mutex(&m) {
  mutex->lock();
}

Lock::Lock(Lock &&other) {
  mutex = other.mutex;
  other.mutex = nullptr;
}

Lock::~Lock() {
  if (mutex) mutex->unlock();
}

EmptyLock::EmptyLock() : mutex(nullptr) {}

EmptyLock::~EmptyLock() {
  if (mutex) mutex->unlock();
}

void EmptyLock::setLock(Mutex *m) {
  if (m) m->lock();
  if (mutex) mutex->unlock();
  mutex = m;
}

void EmptyLock::setLock(Mutex &m) {
  setLock(&m);
}

MutexRef::MutexRef() : mutex(newMutex()) {}

MutexRef::~MutexRef() {
  delete mutex;
}

MutexRef::operator Mutex*() const {
  return mutex;
}

Mutex *MutexRef::operator->() const {
  return mutex;
}

Channel *luax_checkchannel(lua_State *L, int) {
  luaL_error(L, "love.thread Channel objects are not available in this Kandelo build");
  return nullptr;
}

uint64 Channel::push(const Variant &) {
  return 0;
}

}  // namespace thread

}  // namespace love

extern "C" bool kandelo_love_register_native_renderer(lua_State *L, const char *root,
                                                       int width, int height,
                                                       int pixelWidth, int pixelHeight,
                                                       int desktopWidth, int desktopHeight,
                                                       SwapCallback swap) {
  gNative.root = root ? root : ".";
  gNative.width = width > 0 ? width : 960;
  gNative.height = height > 0 ? height : 540;
  gNative.pixelWidth = pixelWidth > 0 ? pixelWidth : gNative.width;
  gNative.pixelHeight = pixelHeight > 0 ? pixelHeight : gNative.height;
  gNative.desktopWidth = desktopWidth > 0 ? desktopWidth : gNative.pixelWidth;
  gNative.desktopHeight = desktopHeight > 0 ? desktopHeight : gNative.pixelHeight;
  gNative.swap = swap;

  try {
    installFilesystem();
    installWindow();
  } catch (love::Exception &e) {
    std::fprintf(stderr, "love: native backend setup failed: %s\n", e.what());
    return false;
  }

  if (!callLuaOpen(L, "love.filesystem", love::filesystem::luaopen_love_filesystem)) return false;
  if (!callLuaOpen(L, "love.data", love::data::luaopen_love_data)) return false;
  if (!callLuaOpen(L, "love.image", love::image::luaopen_love_image)) return false;
  if (!callLuaOpen(L, "love.font", love::font::luaopen_love_font)) return false;
  if (!callLuaOpen(L, "love.math", love::math::luaopen_love_math)) return false;
  if (!callLuaOpen(L, "love.window", love::window::luaopen_love_window)) return false;
  if (!callLuaOpen(L, "love.graphics", love::graphics::luaopen_love_graphics)) return false;
  if (!callLuaOpen(L, "love.physics", love::physics::box2d::luaopen_love_physics)) return false;

  auto *window = love::Module::getInstance<love::window::Window>(love::Module::M_WINDOW);
  if (window != nullptr && !window->isOpen()) {
    love::window::WindowSettings settings;
    try {
      if (!window->setWindow(gNative.width, gNative.height, &settings)) {
        std::fprintf(stderr, "love: native backend failed to open initial window\n");
        return false;
      }
    } catch (love::Exception &e) {
      std::fprintf(stderr, "love: native backend failed to open initial window: %s\n", e.what());
      return false;
    }
  }

  return true;
}
