#pragma once

namespace {{NAMESPACE}} {
// Call after the project's custom render pipeline has been initialized.
bool installRenderProbe();
unsigned int executionCount();
} // namespace {{NAMESPACE}}
