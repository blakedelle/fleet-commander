## Inspiration

Warehouse robot fleets stream constant low-level telemetry, but when something goes wrong, most systems just raise a generic alarm and wait for a person to work out what happened. That doesn't scale: every robot you add means more engineers reading sensor data. We wanted to see how much of that diagnosis an AI agent could take on, and to build a safe way for it to act on what it finds.

We originally set out to build a physical ROS 2 robot. When we couldn't get the hardware, we pivoted to a simulated fleet, which turned out to be a better fit for the idea, because it let us inject faults on demand and test the agent repeatedly.

## What it does

Fleet Commander is a real-time mission control for a fleet of simulated warehouse robots. The robots report only **raw sensor readings**: battery voltage, motor currents, wheel velocities, position, and IMU attitude. There are no error codes or labels anywhere.

A lightweight anomaly gate inside SpacetimeDB notices that something is off and opens an incident. A **Nemotron agent** then investigates with tools, forms a diagnosis, takes action, and **verifies the fix against fresh telemetry**. If the fix fails or the problem can't be solved remotely, it quarantines the robot, preventing any new actions from being assigned to it, and escalates to a human with a message describing what physically needs to happen.

We built three hidden faults: a **motor stall** (fixed by reversing), **odometry drift** (fixed by recalibrating), and a **flipped robot**, which no remote action can fix. The agent's prompt never names that last failure. It has to work out from the readings that the chassis is upside down, stop the motors, and call a human.

A live dashboard shows the fleet, the incidents, and the agent's reasoning and actions as they happen.

## How we built it

- **SpacetimeDB** holds the state and rules: eight tables, the anomaly gate inside the telemetry reducer, the incident lifecycle, a command queue for robot actions, and fault injection. Real-time subscriptions connect the simulator, the agent, and the dashboard, with no separate message bus.
- **A simulator** (TypeScript) runs the robots with simple differential-drive physics and hidden fault injection, and applies the commands the agent sends.
- **The Nemotron bridge** (TypeScript) uses Nemotron through NVIDIA's OpenAI-compatible API with function calling. It has 15 analysis tools that read live data (including a dead-reckoning check that compares wheel encoders against reported position), robot actions, human escalation, and structured diagnosis and close-out tools.
- **Guardrails live in code, not just the prompt:** validated arguments, action and turn limits, retries with backoff, a watchdog for stuck incidents, and automatic escalation if the AI can't finish. The agent can't close an incident as resolved unless an automated health check passes.
- **A React dashboard** subscribes to the database and streams everything live.

## Challenges we ran into

- **Making the AI more than a switch statement.** Our first design had the simulator report labeled errors, so the model was just matching names to fixes. We rebuilt it around raw telemetry only, and the model now has to diagnose.
- **Teaching the agent to verify honestly.** In one run, the agent saw the position estimate jump right after a successful recalibration and read it as a new failure. We made the tools aware of when each action took effect and added a health check built on the same gate that opens incidents.
- **Plausible but wrong diagnoses.** Early on the agent blamed the IMU for a flipped robot, and once called drift "wheel slip." Adding physics notes and a tool that shows whether position error follows the robot's heading fixed these, though each prompt change also risked breaking another scenario.
- **Distributed-systems bugs.** A repaired robot opened a ghost incident because one last stale sample arrived after the fix. Network drops mid-incident taught us to retry the model request but never a robot command.

## Accomplishments that we're proud of

- A **complete closed loop**: raw data, anomaly, diagnosis, action, verification, and resolution or escalation, all running live.
- The agent handles a **situation we never named in its prompt**, the flipped robot, by reasoning from physics.
- The agent reliably diagnosed all three faults across repeated runs, with specific numbers as evidence.
- Verification is separate from the model: **the LLM proposes and the system checks.**
- A working system built in 24 hours, with a team of two.

## What we learned

- LLMs do much better when they have analysis tools than when they're handed raw numbers to compute in their "heads".
- Removing labels from the data is what makes an AI task real.
- Prompts need regression testing. A rule that fixed one scenario broke another until we re-ran all of them.
- The most important safeguards are the ones the model can't talk its way around.
- Simulation is a great way to build and test an agent safely before any real hardware is involved.

## What's next for Fleet Commander

- **Connect to real robots** through a ROS 2 bridge that forwards telemetry and executes commands.
- **Learned per-robot baselines** instead of hand-tuned thresholds.
- **Concurrent agents** and cross-robot reasoning for fleet-wide problems like a bad floor patch or a firmware bug.
- More fault types and long-term trend analysis, such as catching a degrading battery before it fails.
- **Direct low level control** of the robot rather than being limited to preexisting commands