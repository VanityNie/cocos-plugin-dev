#include "RenderProbe.h"
#include <atomic>
#include <memory>
#include "core/Root.h"
#include "renderer/pipeline/custom/CustomTypes.h"
#include "renderer/pipeline/custom/NativePipelineTypes.h"

namespace {{NAMESPACE}} {
namespace {
std::atomic<unsigned int> executions{0};
constexpr std::string_view NAME = "{{NAME}}.probe.v1";

class RenderProbe final : public cc::render::CustomComputePass {
public:
    std::string_view getName() const noexcept override { return NAME; }
    void beginComputePass(const cc::render::CustomRenderGraphContext&,
                          cc::render::RenderGraph::vertex_descriptor) override {
        // Only verifies dispatch reaches the native plugin. This probe does not
        // write pixels, dispatch shaders, run inference, or declare output valid.
        ++executions;
    }
    void endComputePass(const cc::render::CustomRenderGraphContext&,
                        cc::render::RenderGraph::vertex_descriptor) override {}
};
} // namespace

bool installRenderProbe() {
    auto* root = cc::Root::getInstance();
    if (!root) return false;
    auto* pipeline = dynamic_cast<cc::render::NativePipeline*>(root->getCustomPipeline());
    if (!pipeline) return false;
    // Registry belongs to each pipeline; a process-global installed flag would
    // incorrectly skip registration after a pipeline is recreated.
    if (pipeline->custom.computePasses.find(NAME) == pipeline->custom.computePasses.end()) {
        pipeline->addCustomComputePass(NAME, std::make_shared<RenderProbe>());
    }
    return true;
}

unsigned int executionCount() { return executions.load(); }
} // namespace {{NAMESPACE}}
