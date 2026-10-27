#include <chrono>
#include <clocale>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

namespace {

class RuntimeLog {
public:
    RuntimeLog() {
        const char *enabled = std::getenv("CPD_RUNTIME_LOG");
        if (!enabled || std::strcmp(enabled, "1") != 0) return;
        // Windows 引擎通过 wprintf 输出日志，字符转换使用 UTF-8。
        std::setlocale(LC_CTYPE, ".UTF8");
        worker = std::thread([this] {
            std::unique_lock<std::mutex> lock(mutex);
            while (!wake.wait_for(lock, std::chrono::milliseconds(200), [this] { return stopping; })) {
                lock.unlock();
                flush();
                lock.lock();
            }
            flush();
        });
    }

    ~RuntimeLog() {
        if (!worker.joinable()) return;
        {
            std::lock_guard<std::mutex> lock(mutex);
            stopping = true;
        }
        wake.notify_one();
        worker.join();
    }

private:
    static void flush() {
        // 批量刷新保留 stdio 缓冲的写入效率，并及时显示低频日志。
        std::fflush(stdout);
        std::fflush(stderr);
    }

    std::mutex mutex;
    std::condition_variable wake;
    bool stopping = false;
    std::thread worker;
};

RuntimeLog runtimeLog;

} // namespace
