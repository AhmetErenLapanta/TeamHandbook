import { doctorExitCode, formatDoctor, runDoctor } from "../lib/doctor.js";

const report = runDoctor();
console.log(formatDoctor(report));
process.exitCode = doctorExitCode(report);
