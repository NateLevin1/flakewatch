import {
    parse,
    BaseJavaCstVisitorWithDefaults,
    type ClassDeclarationCtx,
    type MethodDeclarationCtx,
} from "java-parser";

export type Test = {
    name: string;
    startLine: number;
    endLine: number;
};

export function parseTests(filename: string, file: string) {
    const visitor = new FlakewatchVisitor(filename);
    const cst = parse(file);
    visitor.visit(cst);
    return visitor.tests;
}

class FlakewatchVisitor extends BaseJavaCstVisitorWithDefaults {
    isJUnit3 = false;
    testClassName: string;
    tests: Test[] = [];
    constructor(filename: string) {
        super();
        this.testClassName = filename.replace(".java", "");
    }

    override classDeclaration(ctx: ClassDeclarationCtx) {
        const className =
            ctx.normalClassDeclaration?.[0]?.children?.typeIdentifier?.[0]
                ?.children?.Identifier?.[0]?.image;
        if (!className) return;

        if (className !== this.testClassName) {
            return; // not the class we're looking for, we will not go deeper
        }

        const extendsClass =
            ctx.normalClassDeclaration?.[0]?.children?.classExtends?.[0]
                ?.children?.classType?.[0]?.children?.Identifier?.[0]?.image;
        this.isJUnit3 = extendsClass === "TestCase";

        const body = ctx.normalClassDeclaration?.[0]?.children?.classBody;
        if (!body) return;

        this.visit(body);
    }

    override methodDeclaration(ctx: MethodDeclarationCtx) {
        if (!ctx.methodModifier) return;

        const testName =
            ctx.methodHeader?.[0]?.children?.methodDeclarator?.[0]?.children
                ?.Identifier?.[0]?.image;

        const methodLocation = ctx.methodBody?.[0]?.location;
        if (!methodLocation) return;
        const { startLine, endLine } = methodLocation; // 1-indexed
        const isVoid =
            !!ctx.methodHeader?.[0]?.children?.result?.[0]?.children?.Void;

        if (!testName || !startLine || !endLine || !isVoid) return;

        if (!this.isJUnit3) {
            // JUnit 4 & 5 use the @Test annotation
            let hasTestAnnotation = false;
            for (const modifier of ctx.methodModifier) {
                if (
                    !!modifier.children.annotation?.find(
                        (n) =>
                            n.children?.typeName?.[0]?.children?.Identifier?.[0]
                                ?.image === "Test"
                    )
                )
                    hasTestAnnotation = true;
            }
            if (!hasTestAnnotation) return;
        } else {
            // JUnit 3 test methods start with "test"
            if (!testName.startsWith("test")) return;
        }

        this.tests.push({ name: testName, startLine, endLine });
    }

    getTests() {
        return this.tests;
    }
}
