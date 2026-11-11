<?xml version="1.0"?>
<!--
  Date a man page that carries no date of its own with the release date
  passed as kandelo.release.date. DocBook XSL would otherwise stamp the
  build clock (its get.refentry.date fallback), and upstream's page
  sources do not say when they were written. A page that does carry a
  date keeps it, exactly as in DocBook XSL's own template.
-->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">
  <xsl:param name="kandelo.release.date"/>
  <xsl:template name="get.refentry.date">
    <xsl:param name="refname"/>
    <xsl:param name="info"/>
    <xsl:param name="prefs"/>
    <xsl:choose>
      <xsl:when test="$info/date/node()|$info/pubdate/node()">
        <xsl:apply-templates
            select="(($info[date])[last()]/date)[1]|
                    (($info[pubdate])[last()]/pubdate)[1]"/>
      </xsl:when>
      <xsl:when test="$kandelo.release.date != ''">
        <xsl:value-of select="$kandelo.release.date"/>
      </xsl:when>
      <xsl:otherwise>
        <xsl:message terminate="yes">
          <xsl:text>release-date.xsl: no kandelo.release.date for </xsl:text>
          <xsl:value-of select="$refname"/>
        </xsl:message>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>
</xsl:stylesheet>
