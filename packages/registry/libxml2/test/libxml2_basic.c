#include <stdio.h>
#include <string.h>
#include <libxml/parser.h>
#include <libxml/tree.h>

int main(void) {
    const char *xml = "<root><item>hello-xml</item></root>";

    xmlDocPtr doc = xmlReadMemory(xml, strlen(xml), "noname.xml", NULL,
        XML_PARSE_NONET);
    if (doc == NULL) {
        printf("FAIL: xmlReadMemory returned NULL\n");
        return 1;
    }
    printf("OK: parsed XML document\n");

    xmlNodePtr root = xmlDocGetRootElement(doc);
    if (root == NULL) {
        printf("FAIL: no root element\n");
        xmlFreeDoc(doc);
        return 1;
    }

    if (xmlStrcmp(root->name, (const xmlChar *)"root") != 0) {
        printf("FAIL: root element name is '%s', expected 'root'\n", root->name);
        xmlFreeDoc(doc);
        return 1;
    }
    printf("OK: root element is 'root'\n");

    xmlNodePtr item = root->children;
    if (item && item->children) {
        xmlChar *content = xmlNodeGetContent(item);
        printf("OK: item content is '%s'\n", (char *)content);
        xmlFree(content);
    }

    xmlFreeDoc(doc);
    xmlCleanupParser();

    printf("PASS\n");
    return 0;
}
