import { test } from "bun:test";
import { nativeAutonomyRuntime } from "./fixtures/autonomy-native-runtime";

const nativeTest = process.env.OMP_SUPERAGENT_NATIVE_TEST === "1" ? test : test.skip;

nativeTest("managed native work delivers intermediate progress before settlement, continues goals across turns, and resumes on the original topic without idle model calls",
  nativeAutonomyRuntime, 120_000);
