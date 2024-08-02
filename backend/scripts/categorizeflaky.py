import sys
import csv

def categorize_flaky(detector_runs):
    tests = {}
    for run in detector_runs:
        [test, prefix_md5, tool, status, failure_md5, log] = run
        if test == 'test':
            continue # Skip header

        if not "#" in test or (status != "pass" and status != "fail"):
            print(f"Err: invalid line: {run}")
            print(" - Test must match format TestClass#method and status must be pass or fail")
            sys.exit(1)

        test_info = tests.get(test)
        if test_info == None:
            test_info = TestInfo()
            tests[test] = test_info

        test_info.update(status, prefix_md5, tool, log)

    result = ""
    for test in tests:
        result += f"\"{test}\": \"{tests[test].categorize()}\", "

    result = result[:-2]

    print("{", end=" ")
    print(result, end=" ")
    print("}")


class TestInfo:
    def __init__(self):
        self.passes_w_prefix = set()
        self.fails_w_prefix = set()
        self.passes_wo_prefix = False
        self.fails_wo_prefix = False

        self.fails_nondex = set()
        self.passes_nondex = set()

    def update(self, status, prefix_md5, tool, log):
        if tool == "NonDex":
            if status == "fail":
                self.fails_nondex.add(log)
            elif status == "pass":
                self.passes_nondex.add(log)
            return

        if prefix_md5 != "":
            if status == "pass":
                self.passes_w_prefix.add(prefix_md5)
            else:
                self.fails_w_prefix.add(prefix_md5)
        else:
            if status == "pass":
                self.passes_wo_prefix = True
            else:
                self.fails_wo_prefix = True

    def _fails_with_prefix(self):
        return len(self.fails_w_prefix) > 0
    def _passes_with_prefix(self):
        return len(self.passes_w_prefix) > 0
    def _passes_anywhere(self):
        return self.passes_wo_prefix or self._passes_with_prefix()

    
    def categorize(self):
        # Check for ID: passed somewhere, failed every time when run under NonDex with a certain seed
        if self._passes_anywhere():
            for seed in self.fails_nondex:
                if not seed in self.passes_nondex:
                    # ID&NOD: ID and failed when run w/o prefix
                    if self.fails_wo_prefix:
                        return "ID&NOD"
                    else:
                        return "ID"
        
        # Check for OD: always failed in some order, always passed in a different order
        # OD-Vic: never fails with empty prefix
        # OD-Brit: always fails with empty prefix
        same_order_passed_and_failed = len(self.fails_w_prefix.intersection(self.passes_w_prefix))
        if same_order_passed_and_failed == 0 and len(self.fails_w_prefix) > 0 and len(self.passes_w_prefix) > 0:
            if not self.fails_wo_prefix:
                return "OD-Vic"
            elif not self.passes_wo_prefix:
                return "OD-Brit"
        
        passes_and_fails_w_prefix = self._fails_with_prefix() and self._passes_with_prefix()
        passes_and_fails_wo_prefix = self.fails_wo_prefix and self.passes_wo_prefix
        # Check for NOD: all else where same test passed and failed
        if passes_and_fails_w_prefix or passes_and_fails_wo_prefix:
            return "NOD"
        
        return ""

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 categorizeflaky.py <csv file>")
        sys.exit(1)

    csv_path = sys.argv[1]
    with open(csv_path, 'r') as f:
        reader = csv.reader(f)
        detector_runs = list(reader)
        categorize_flaky(detector_runs)
